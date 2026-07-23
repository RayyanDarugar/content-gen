# Multi-Tenant Phase C — Buffer OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user connect their own Buffer account via OAuth and post carousels to their own channels — making the `/post` flow tenant-safe (it currently posts through Rayyan's shared Buffer tokens).

**Architecture:** Standard OAuth 2.0 authorization-code + PKCE against Buffer (confidential client). Per-user access + refresh tokens are AES-encrypted (reusing Phase B's `encryptSecret`) in the existing `user_settings` table. A `getValidBufferToken` helper transparently refreshes expired tokens (Buffer rotates the refresh token on every refresh — must re-store it). The config page gains a Buffer-connect section and a real channel-picker dropdown (via Buffer's GraphQL `channels` query) plus the per-category caption. Posting swaps the shared `BUFFER_TOKEN_1/2` env tokens for the acting user's OAuth token.

**Tech Stack:** Next.js 16 (App Router route handlers), TypeScript, Supabase, Node `crypto` (PKCE), Buffer OAuth + GraphQL API, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-multi-tenant-beta-design.md` §9 — governs on any conflict. Builds on completed Phases A + B (branch `multi-tenant`).
- **Buffer OAuth endpoints (verbatim from developers.buffer.com):**
  - Authorize: `GET https://auth.buffer.com/auth` with query params `client_id`, `redirect_uri`, `response_type=code`, `scope` (space-separated), `state`, `code_challenge`, `code_challenge_method=S256`, `prompt=consent`.
  - Token: `POST https://auth.buffer.com/token`, `Content-Type: application/x-www-form-urlencoded`, body `client_id`, `client_secret`, `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`.
  - Token response JSON: `access_token`, `refresh_token`, `token_type`, `expires_in` (seconds), `scope`.
  - Refresh: `POST https://auth.buffer.com/token` form body `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`. **Every successful refresh returns a NEW `refresh_token` and invalidates the one sent — the new refresh token MUST be stored, or the next refresh fails.**
- **Scopes requested:** `posts:read posts:write account:read offline_access` (post, list channels, and get refresh tokens).
- **PKCE:** `code_verifier` = base64url of 32 random bytes (no padding); `code_challenge` = base64url(SHA-256(verifier)) (no padding); method `S256`. Node's `"base64url"` encoding handles the `+/`→`-_` substitution and strips padding.
- **Buffer GraphQL API:** `POST https://api.buffer.com`, `Content-Type: application/json`, `Authorization: Bearer <accessToken>`. Channels are listed in two steps: `query GetOrganizations { account { organizations { id name ownerEmail } } }` (→ `data.account.organizations[].id`), then `query GetChannels { channels(input: { organizationId: "..." }) { id name displayName service avatar isQueuePaused } }` (→ `data.channels[]`).
- Buffer tokens are AES-256-GCM encrypted via Phase B's `encryptSecret`/`decryptSecret`, stored in `user_settings`, decrypted server-side only, never returned to the client.
- Service-role admin-client reads/writes of tenant data must filter `.eq("user_id", userId)` (Phase A/B convention). Config actions using the RLS-enforced `createServerSupabase` client rely on RLS.
- App-level env (set in `.env.local` + Vercel): `BUFFER_CLIENT_ID`, `BUFFER_CLIENT_SECRET`. The old `BUFFER_TOKEN_1/2` become unused after Task 7.
- `redirect_uri` is derived from the incoming request's origin (`new URL("/auth/buffer/callback", request.url)`) so it works across localhost / preview / prod — but every origin used must be registered as a redirect URI on the Buffer App Client, and the value sent at authorize time and at token-exchange time must be byte-identical.
- Working dir is the worktree `.worktrees/multi-tenant` on branch `multi-tenant`. Read `node_modules/next/dist/docs/` before writing Next.js route handlers (per AGENTS.md).
- Verification: PKCE is unit-tested (pure). The OAuth flow, token refresh, channel listing, and posting are integration paths against a live external API — verified by `npm run build` + `npm test` (suite stays green) + the real end-to-end acceptance test in Task 8, not by fabricated unit tests. Do not write tests that assert nothing.

## File Structure

- `lib/buffer/pkce.ts` — PKCE verifier/challenge (create); `tests/pkce.test.ts` (create)
- `supabase/migrations/0007_buffer_tokens.sql` — add buffer token columns to user_settings (create)
- `lib/types.ts` — `BufferChannel` type; remove `buffer_account` from `Category` (modify)
- `lib/settings/buffer.ts` — token store/refresh/status/disconnect + channel listing (create)
- `app/auth/buffer/route.ts` — OAuth connect redirect (create)
- `app/auth/buffer/callback/route.ts` — OAuth callback + token storage (create)
- `app/(app)/config/buffer-section.tsx` — connect/disconnect UI (create)
- `app/(app)/config/category-manager.tsx` — add channel dropdown + caption (modify)
- `app/(app)/config/actions.ts` — category actions save channel_id + post_caption; `disconnectBufferAction` (modify)
- `app/(app)/config/page.tsx` — fetch buffer status + channels, render Buffer section (modify)
- `lib/athena/buffer.ts` — `postToBuffer` takes an access token (modify)
- `lib/athena/carousel.ts` — remove `bufferTokenFor` (modify)
- `tests/carousel.test.ts` — drop the `bufferTokenFor` tests (modify)
- `app/api/posts/create/route.ts` — use the user's OAuth token (modify)

---

### Task 1: PKCE helper (pure, TDD)

**Files:**
- Create: `lib/buffer/pkce.ts`
- Test: `tests/pkce.test.ts`

**Interfaces:**
- Produces: `generateCodeVerifier(): string`, `computeCodeChallenge(verifier: string): string`. Task 4 consumes both.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/pkce.test.ts
import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { generateCodeVerifier, computeCodeChallenge } from "@/lib/buffer/pkce";

describe("pkce", () => {
  it("generates a base64url verifier with no padding", () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet, no '=' padding
    expect(v.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url ≈ 43 chars
  });

  it("generates a different verifier each call", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it("computes challenge = base64url(sha256(verifier)) with no padding", () => {
    const verifier = "test_verifier_abc123";
    const expected = createHash("sha256").update(verifier).digest("base64url");
    const challenge = computeCodeChallenge(verifier);
    expect(challenge).toBe(expected);
    expect(challenge).not.toContain("="); // no padding
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pkce.test.ts`
Expected: FAIL — cannot resolve `@/lib/buffer/pkce`.

- [ ] **Step 3: Implement `lib/buffer/pkce.ts`**

```ts
import { createHash, randomBytes } from "crypto";

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function computeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pkce.test.ts` → PASS. Then `npm test` → full suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/buffer/pkce.ts tests/pkce.test.ts
git commit -m "feat: PKCE code verifier/challenge helpers"
```

---

### Task 2: Migration 0007 + types

**Files:**
- Create: `supabase/migrations/0007_buffer_tokens.sql`
- Modify: `lib/types.ts`

**Interfaces:**
- Produces: `user_settings` buffer columns; `BufferChannel` type; `Category` without `buffer_account`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0007_buffer_tokens.sql
-- Phase C: per-user Buffer OAuth tokens (encrypted) on user_settings.
-- buffer_connected_at IS NULL means the user has not connected Buffer.
-- Note: categories.buffer_account (the old 1|2 shared-account selector) is left
-- in place as a now-unused column — dropping it is deferred to avoid coordinating
-- a column drop with the posting rework; it defaults to 1 and is never read after
-- Phase C. A future cleanup migration may drop it.

alter table user_settings add column buffer_access_token_enc text not null default '';
alter table user_settings add column buffer_refresh_token_enc text not null default '';
alter table user_settings add column buffer_token_expires_at timestamptz;
alter table user_settings add column buffer_connected_at timestamptz;
```

- [ ] **Step 2: USER STEP — apply the migration**

The controller must have Rayyan run `0007_buffer_tokens.sql` in the new Supabase project's SQL editor before Task 3+ can be live-verified.

- [ ] **Step 3: Add the `BufferChannel` type to `lib/types.ts`**

Append the interface only. Do NOT modify `Category` in this task — `buffer_account` stays in the type for now because `app/api/posts/create/route.ts` still reads it; that field and its last reader are both removed together in Task 7, keeping every commit's build green.

```ts
export interface BufferChannel {
  id: string;
  name: string;
  displayName: string;
  service: string;
  avatar: string;
  isQueuePaused: boolean;
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: SUCCESS (additive type change only).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_buffer_tokens.sql lib/types.ts
git commit -m "feat: migration 0007 - buffer token columns; BufferChannel type"
```

---

### Task 3: Buffer token store, refresh, status, disconnect

**Files:**
- Create: `lib/settings/buffer.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (Phase B), `createAdminSupabase`.
- Produces:
  - `storeBufferTokens(userId: string, t: { access_token: string; refresh_token: string; expires_in: number }): Promise<void>`
  - `getValidBufferToken(userId: string): Promise<string>` — throws `Error("Connect Buffer in Config")` if not connected; transparently refreshes if expired.
  - `getBufferStatus(userId: string): Promise<{ connected: boolean }>`
  - `disconnectBuffer(userId: string): Promise<void>`

- [ ] **Step 1: Implement `lib/settings/buffer.ts`**

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";

const TOKEN_URL = "https://auth.buffer.com/token";
const EXPIRY_SKEW_MS = 60_000; // refresh a minute early to avoid edge races

interface BufferRow {
  buffer_access_token_enc: string;
  buffer_refresh_token_enc: string;
  buffer_token_expires_at: string | null;
  buffer_connected_at: string | null;
}

async function fetchBufferRow(userId: string): Promise<BufferRow | null> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("user_settings")
    .select("buffer_access_token_enc, buffer_refresh_token_enc, buffer_token_expires_at, buffer_connected_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_settings query failed: ${error.message}`);
  return (data as BufferRow) ?? null;
}

export async function storeBufferTokens(
  userId: string,
  t: { access_token: string; refresh_token: string; expires_in: number },
): Promise<void> {
  const supabase = createAdminSupabase();
  const expiresAt = new Date(Date.now() + t.expires_in * 1000).toISOString();
  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: userId,
      buffer_access_token_enc: encryptSecret(t.access_token),
      buffer_refresh_token_enc: encryptSecret(t.refresh_token),
      buffer_token_expires_at: expiresAt,
      buffer_connected_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`failed to store buffer tokens: ${error.message}`);
}

export async function getBufferStatus(userId: string): Promise<{ connected: boolean }> {
  const row = await fetchBufferRow(userId);
  return { connected: !!row?.buffer_connected_at };
}

export async function disconnectBuffer(userId: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("user_settings").update({
    buffer_access_token_enc: "",
    buffer_refresh_token_enc: "",
    buffer_token_expires_at: null,
    buffer_connected_at: null,
  }).eq("user_id", userId);
  if (error) throw new Error(`failed to disconnect buffer: ${error.message}`);
}

export async function getValidBufferToken(userId: string): Promise<string> {
  const row = await fetchBufferRow(userId);
  if (!row?.buffer_connected_at || !row.buffer_access_token_enc) {
    throw new Error("Connect Buffer in Config");
  }
  const notExpired =
    row.buffer_token_expires_at &&
    new Date(row.buffer_token_expires_at).getTime() - EXPIRY_SKEW_MS > Date.now();
  if (notExpired) return decryptSecret(row.buffer_access_token_enc);

  // Expired (or unknown expiry) — refresh. Buffer ROTATES the refresh token on
  // every refresh and invalidates the old one, so the new refresh token MUST be
  // stored or the next refresh will fail.
  const refreshToken = decryptSecret(row.buffer_refresh_token_enc);
  const body = new URLSearchParams({
    client_id: process.env.BUFFER_CLIENT_ID ?? "",
    client_secret: process.env.BUFFER_CLIENT_SECRET ?? "",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`buffer token refresh failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number };
  await storeBufferTokens(userId, json); // persists the NEW rotated refresh token
  return json.access_token;
}
```

- [ ] **Step 2: Verify build** (`npm run build` → SUCCESS).

- [ ] **Step 3: Commit**

```bash
git add lib/settings/buffer.ts
git commit -m "feat: buffer token store, refresh (with rotation), status, disconnect"
```

---

### Task 4: OAuth connect + callback routes

**Files:**
- Create: `app/auth/buffer/route.ts`
- Create: `app/auth/buffer/callback/route.ts`

**Interfaces:**
- Consumes: `requireUser`, `generateCodeVerifier`/`computeCodeChallenge` (Task 1), `storeBufferTokens` (Task 3).
- Produces: `/auth/buffer` (begins OAuth), `/auth/buffer/callback` (completes it).

- [ ] **Step 1: Implement `app/auth/buffer/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { requireUser } from "@/lib/auth/require-user";
import { generateCodeVerifier, computeCodeChallenge } from "@/lib/buffer/pkce";

const SCOPES = "posts:read posts:write account:read offline_access";

export async function GET(request: NextRequest) {
  try {
    await requireUser();
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  const clientId = process.env.BUFFER_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(new URL("/config?buffer=misconfigured", request.url));
  }

  const verifier = generateCodeVerifier();
  const challenge = computeCodeChallenge(verifier);
  const state = randomBytes(16).toString("base64url");
  const redirectUri = new URL("/auth/buffer/callback", request.url).toString();

  const authorize = new URL("https://auth.buffer.com/auth");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", SCOPES);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("prompt", "consent");

  const res = NextResponse.redirect(authorize.toString());
  // `secure` must be conditional: secure cookies are NOT sent over plain http,
  // so hardcoding `true` would break the verifier/state round-trip on localhost
  // dev (http). NODE_ENV is "production" on Vercel (incl. preview, which is https).
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("buffer_pkce_verifier", verifier, cookieOpts);
  res.cookies.set("buffer_oauth_state", state, cookieOpts);
  return res;
}
```

- [ ] **Step 2: Implement `app/auth/buffer/callback/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { storeBufferTokens } from "@/lib/settings/buffer";

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const verifier = request.cookies.get("buffer_pkce_verifier")?.value;
  const expectedState = request.cookies.get("buffer_oauth_state")?.value;

  const fail = (reason: string) => {
    const res = NextResponse.redirect(new URL(`/config?buffer=error`, request.url));
    res.cookies.delete("buffer_pkce_verifier");
    res.cookies.delete("buffer_oauth_state");
    console.error("buffer oauth callback failed:", reason);
    return res;
  };

  if (!code || !state || !verifier || !expectedState) return fail("missing code/state/verifier");
  if (state !== expectedState) return fail("state mismatch (possible CSRF)");

  const redirectUri = new URL("/auth/buffer/callback", request.url).toString();
  const body = new URLSearchParams({
    client_id: process.env.BUFFER_CLIENT_ID ?? "",
    client_secret: process.env.BUFFER_CLIENT_SECRET ?? "",
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch("https://auth.buffer.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) return fail(`token exchange HTTP ${res.status}: ${text.slice(0, 300)}`);

  let json: { access_token: string; refresh_token: string; expires_in: number };
  try {
    json = JSON.parse(text);
  } catch {
    return fail(`non-JSON token response: ${text.slice(0, 200)}`);
  }
  if (!json.access_token || !json.refresh_token) return fail("token response missing tokens");

  await storeBufferTokens(user.id, json);

  const done = NextResponse.redirect(new URL("/config?buffer=connected", request.url));
  done.cookies.delete("buffer_pkce_verifier");
  done.cookies.delete("buffer_oauth_state");
  return done;
}
```

- [ ] **Step 3: Verify build** (`npm run build` → SUCCESS; both routes appear in the route table).

- [ ] **Step 4: Commit**

```bash
git add app/auth/buffer
git commit -m "feat: Buffer OAuth connect + callback routes (PKCE)"
```

---

### Task 5: Buffer channel listing

**Files:**
- Modify: `lib/settings/buffer.ts` (add `getBufferChannels`)

**Interfaces:**
- Consumes: `getValidBufferToken` (Task 3), `BufferChannel` type (Task 2).
- Produces: `getBufferChannels(userId: string): Promise<BufferChannel[]>` — returns the user's channels across all their Buffer organizations; returns `[]` if none.

- [ ] **Step 1: Add `getBufferChannels` to `lib/settings/buffer.ts`**

```ts
import type { BufferChannel } from "@/lib/types";

const GRAPHQL_URL = "https://api.buffer.com";

async function bufferGraphQL<T>(accessToken: string, query: string): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`buffer graphql HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(`buffer graphql errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data as T;
}

export async function getBufferChannels(userId: string): Promise<BufferChannel[]> {
  const token = await getValidBufferToken(userId);
  const orgs = await bufferGraphQL<{ account: { organizations: { id: string }[] } }>(
    token,
    `query GetOrganizations { account { organizations { id name ownerEmail } } }`,
  );
  const orgIds = orgs.account?.organizations?.map((o) => o.id) ?? [];
  const all: BufferChannel[] = [];
  for (const orgId of orgIds) {
    const data = await bufferGraphQL<{ channels: BufferChannel[] }>(
      token,
      `query GetChannels { channels(input: { organizationId: "${orgId}" }) { id name displayName service avatar isQueuePaused } }`,
    );
    if (Array.isArray(data.channels)) all.push(...data.channels);
  }
  return all;
}
```

Note for the implementer: the GraphQL query strings above are copied verbatim from Buffer's developer docs (`developers.buffer.com/examples/get-organizations.html` and `get-channels.html`) as of this plan's writing. They cannot be unit-tested (they need a live token). If the live acceptance test in Task 8 shows a schema mismatch (field name or `data.*` path differs from the docs), correct the query/response path here — this is the one genuinely doc-derived, unverified-until-runtime piece of the phase, analogous to how Phase 3 verified Buffer's auth header at runtime.

- [ ] **Step 2: Verify build** (`npm run build` → SUCCESS).

- [ ] **Step 3: Commit**

```bash
git add lib/settings/buffer.ts
git commit -m "feat: list a user's Buffer channels via GraphQL"
```

---

### Task 6: Config Buffer section + channel picker + caption

**Files:**
- Create: `app/(app)/config/buffer-section.tsx`
- Modify: `app/(app)/config/actions.ts` (extend `CategoryFields`/create/update with `buffer_channel_id` + `post_caption`; add `disconnectBufferAction`)
- Modify: `app/(app)/config/category-manager.tsx` (channel dropdown + caption field)
- Modify: `app/(app)/config/page.tsx` (fetch status + channels; render Buffer section; pass channels to the manager)

**Interfaces:**
- Consumes: `getBufferStatus`, `getBufferChannels`, `disconnectBuffer` (Tasks 3/5), `requireUser`, `BufferChannel`, `Category`.
- Produces: Buffer connect/disconnect UI; category editor with a channel dropdown + caption; category actions that persist `buffer_channel_id` + `post_caption`.

- [ ] **Step 1: Extend `CategoryFields` and the category actions in `app/(app)/config/actions.ts`**

Add `buffer_channel_id: string;` and `post_caption: string;` to `CategoryFields`. Include both in the `createCategory` insert and the `updateCategory` update payloads (e.g. `buffer_channel_id: fields.buffer_channel_id, post_caption: fields.post_caption`). Then add the disconnect action and import:

```ts
import { disconnectBuffer } from "@/lib/settings/buffer";

export async function disconnectBufferAction() {
  const user = await requireUser();
  await disconnectBuffer(user.id);
  revalidatePath("/config");
}
```

- [ ] **Step 2: Implement `app/(app)/config/buffer-section.tsx`**

```tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { disconnectBufferAction } from "./actions";

export function BufferSection({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Buffer</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">Connection</span>
          <Badge variant={connected ? "success" : "outline"}>
            {connected ? "connected" : "not connected"}
          </Badge>
        </div>
        {connected ? (
          <Button variant="outline" disabled={pending}
            onClick={() => startTransition(async () => { await disconnectBufferAction(); router.refresh(); })}>
            Disconnect
          </Button>
        ) : (
          <Button render={<a href="/auth/buffer" />}>Connect Buffer</Button>
        )}
      </CardContent>
    </Card>
  );
}
```

Note: the `Button render={<a href=... />}` pattern matches this codebase's Base-UI Button (used elsewhere, e.g. gallery `DialogTrigger render={...}`). If the plain-link variant fails to build, fall back to `<a href="/auth/buffer" className={buttonVariants()}>Connect Buffer</a>` importing `buttonVariants` from the button component.

- [ ] **Step 3: Add channel dropdown + caption to `app/(app)/config/category-manager.tsx`**

Extend `EMPTY` and both the create/edit `form` initializers to include `buffer_channel_id: ""` (or `category.buffer_channel_id`) and `post_caption: ""` (or `category.post_caption`). Accept a `channels: BufferChannel[]` prop on `CategoryManager` and pass it down to each `CategoryEditor`. In the editor JSX, add a caption textarea and a channel `<select>`:

```tsx
// props: function CategoryEditor({ category, channels }: { category?: Category; channels: BufferChannel[] })
// ...in the JSX, after the aspect-ratio grid:
      <div><Label>Post caption (use || to separate rotating variants)</Label>
        <Textarea rows={3} value={form.post_caption}
          onChange={(e) => set("post_caption", e.target.value)} /></div>
      <div><Label>Buffer channel</Label>
        {channels.length === 0 ? (
          <p className="text-xs text-muted-foreground">Connect Buffer above to choose a channel.</p>
        ) : (
          <select className="block w-full rounded-md border bg-background p-2 text-sm"
            value={form.buffer_channel_id}
            onChange={(e) => set("buffer_channel_id", e.target.value)}>
            <option value="">— none —</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName || c.name} ({c.service})</option>
            ))}
          </select>
        )}
      </div>
```

Thread `channels` through `CategoryManager({ categories, channels })` to both the mapped editors and the "add new" editor. Import `BufferChannel` from `@/lib/types`.

- [ ] **Step 4: Wire `app/(app)/config/page.tsx`**

Fetch buffer status and channels server-side (channels only if connected; tolerate a fetch failure so the page never hard-fails), render the Buffer section, and pass channels to the manager:

```tsx
import { getBufferStatus, getBufferChannels } from "@/lib/settings/buffer";
import { BufferSection } from "./buffer-section";
import type { BufferChannel } from "@/lib/types";
// ...inside the component, after existing fetches:
  const bufferStatus = await getBufferStatus(user.id);
  let channels: BufferChannel[] = [];
  if (bufferStatus.connected) {
    try { channels = await getBufferChannels(user.id); } catch { channels = []; }
  }
// ...in JSX: render <BufferSection connected={bufferStatus.connected} /> (place it above <CategoryManager/>),
// and pass channels: <CategoryManager categories={...} channels={channels} />
```

- [ ] **Step 5: Verify build + suite + manual**

Run: `npm run build && npm test` → green.
Manual (needs migration 0007, `BUFFER_CLIENT_ID/SECRET`, and a registered App Client — so this fully verifies in Task 8): the Buffer section shows "not connected"; category editor shows the caption field and a "Connect Buffer above…" hint when no channels.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/config"
git commit -m "feat: Buffer connect UI + channel picker + per-category caption"
```

---

### Task 7: Posting rework — use the user's OAuth token

**Files:**
- Modify: `lib/athena/buffer.ts`
- Modify: `lib/athena/carousel.ts`
- Modify: `tests/carousel.test.ts`
- Modify: `app/api/posts/create/route.ts`
- Modify: `lib/types.ts` (remove `buffer_account` from `Category`)

**Interfaces:**
- Consumes: `getValidBufferToken` (Task 3).
- Produces: `postToBuffer(accessToken: string, channelId: string, imageUrls: string[], caption: string)`; posting scoped to the acting user's Buffer connection.

- [ ] **Step 1: Change `postToBuffer` in `lib/athena/buffer.ts` to take an access token**

```ts
import "server-only";
import { buildCreatePostMutation } from "./carousel";

export interface BufferResult { success: boolean; postId: string; error: string; rawBody: string; }

export async function postToBuffer(
  accessToken: string,
  channelId: string,
  imageUrls: string[],
  caption: string,
): Promise<BufferResult> {
  const body = buildCreatePostMutation(channelId, imageUrls, caption);
  const res = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // ...rest of the parsing/return logic unchanged...
}
```

(Remove the `bufferTokenFor` import; everything after the `fetch` call — `rawBody`, `postId`/`error` parsing, return — stays identical.)

- [ ] **Step 2: Remove `bufferTokenFor` from `lib/athena/carousel.ts`**

Delete the `bufferTokenFor` function entirely (the last four-ish lines). `pickCaption`, `selectAutoFill`, `buildCreatePostMutation`, and the `Postable` interface stay unchanged.

- [ ] **Step 3: Drop the `bufferTokenFor` tests from `tests/carousel.test.ts`**

Remove the entire `describe("bufferTokenFor", ...)` block and its `afterEach` for `BUFFER_TOKEN_*`. Keep every other test (`pickCaption`, `selectAutoFill`, `buildCreatePostMutation`). Remove the now-unused `bufferTokenFor` from the import.

- [ ] **Step 4: Update `app/api/posts/create/route.ts` to use the user's token**

Add the import and replace the `postToBuffer` call site:

```ts
import { getValidBufferToken } from "@/lib/settings/buffer";
// ...replace the try/catch around postToBuffer (was: postToBuffer(cat.buffer_account, cat.buffer_channel_id, imageUrls, caption)):
  let result;
  try {
    const accessToken = await getValidBufferToken(user.id);
    result = await postToBuffer(accessToken, cat.buffer_channel_id, imageUrls, caption);
  } catch (e) {
    result = { success: false, postId: "", error: e instanceof Error ? e.message : String(e), rawBody: "" };
  }
```

(If the user hasn't connected Buffer, `getValidBufferToken` throws "Connect Buffer in Config", which is caught here and surfaced as the post failure reason — the same path as any other Buffer error.)

- [ ] **Step 5: Remove `buffer_account` from the `Category` type in `lib/types.ts`**

Delete the `buffer_account: 1 | 2;` line. Then confirm no remaining references:

Run: `grep -rn "buffer_account" app lib` — expected: no matches in code (the DB column remains, but nothing reads it).

- [ ] **Step 6: Verify build + suite**

Run: `npm run build && npm test`
Expected: build succeeds (all `buffer_account`/`bufferTokenFor` references gone), suite green (carousel tests still pass minus the removed block).

- [ ] **Step 7: Commit**

```bash
git add lib/athena/buffer.ts lib/athena/carousel.ts tests/carousel.test.ts app/api/posts/create/route.ts lib/types.ts
git commit -m "feat: posting uses each user's Buffer OAuth token; drop shared-token routing"
```

---

### Task 8: Deploy + production acceptance (user-assisted)

**Files:** none (operational — run by the controller with Rayyan, not a subagent).

- [ ] **Step 1: Register the Buffer App Client (Rayyan)**

In Buffer's developer dashboard → App Clients → New Client: confidential client (has a client secret), scopes `posts:read posts:write account:read offline_access`, and register redirect URIs for every origin that will use it — the Vercel preview URL + `http://localhost:3001` for local dev — each as `<origin>/auth/buffer/callback`. Record `client_id` and `client_secret`.

- [ ] **Step 2: Env + migration (Rayyan)**

Add `BUFFER_CLIENT_ID` and `BUFFER_CLIENT_SECRET` to the worktree `.env.local` and to the Vercel Preview-scoped env (pointed at the beta project). Apply migration `0007_buffer_tokens.sql` in the new Supabase SQL editor. Push the branch so the preview redeploys.

- [ ] **Step 3: Acceptance test (Rayyan, on the preview deployment)**

1. `/config` → Buffer section shows "not connected" → click **Connect Buffer** → Buffer consent screen → approve → redirected back to `/config?buffer=connected`, badge now "connected".
2. A category's editor now shows a channel dropdown populated with the real connected channels; pick one and save.
3. Generate/approve an idea → image → on `/post`, post a carousel for that category → confirm it lands in the correct channel's Buffer queue, History row shows `queued`, ideas flip to `posted`.
4. (If convenient) confirm token refresh survives: after the access token's lifetime, posting still works without reconnecting.

- [ ] **Step 4: If the channel query shape was wrong**

If Step 2 of the acceptance test shows no channels despite a connected account, the GraphQL query/response path in `getBufferChannels` (Task 5) needs correcting against Buffer's live API — fix it, redeploy, re-test.

---

## Phase C completion

After Task 8 passes: each user connects their own Buffer account, picks from their own real channels, and posts to their own queue — `/post` is fully tenant-safe and no longer touches `BUFFER_TOKEN_1/2`. That completes the "minimum usable" beta (Phases A+B+C): a friend can sign up, bring their keys, define their brand + categories, generate on-brand content, connect Buffer, and post — all isolated. Phase D (usage caps + a polished Setup status page) remains as optional polish.
