# Multi-Tenant Phase C — Buffer Personal Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user paste in their own Buffer personal API key and post carousels to their own channels — making `/post` tenant-safe (it currently posts through Rayyan's shared `BUFFER_TOKEN_1/2`).

**Architecture:** BYOK, same pattern as Anthropic/Kie (Phase B): a per-user encrypted `buffer_token_enc` column on `user_settings`. All downstream code (posting, channel listing) goes through one function, `getValidBufferToken(userId): Promise<string>` — that's the deliberate abstraction boundary. It returns a valid bearer token today by simple decryption; if this app later upgrades to Buffer OAuth (see the deferred plan at `docs/superpowers/plans/2026-07-23-multi-tenant-phase-c-buffer-oauth.md`, kept as the researched upgrade path — verbatim Buffer endpoints, the refresh-token-rotation gotcha, etc.), only this one function's internals change to add expiry/refresh logic. No caller (`postToBuffer`, `getBufferChannels`, the posting route) needs to change.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase, Buffer's GraphQL API, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-multi-tenant-beta-design.md` §9 — governs on any conflict, with this plan's BYOK approach superseding that section's OAuth sketch (a since-made, better-informed call; the researched OAuth plan is retained for the future).
- **Buffer's personal-key auth is already proven in this codebase**: `BUFFER_TOKEN_1/2` are personal keys (Buffer dashboard → Settings → API → Personal Keys), and `Authorization: Bearer <token>` against `https://api.buffer.com` has been live and working since Phase 3. Nothing about the auth mechanism itself is new or unverified — only the per-user storage/retrieval is new.
- **Buffer GraphQL API:** `POST https://api.buffer.com`, `Content-Type: application/json`, `Authorization: Bearer <token>`. Channel listing is two GraphQL calls: `query GetOrganizations { account { organizations { id name ownerEmail } } }` (→ `data.account.organizations[].id`), then per org `query GetChannels { channels(input: { organizationId: "..." }) { id name displayName service avatar isQueuePaused } }` (→ `data.channels[]`). These exact query strings are copied from Buffer's docs and are the one piece not verifiable until Task 6's live acceptance test — if the live shape differs, fix the query/response path in Task 2, same pattern used for the Buffer auth header back in Phase 3.
- Buffer tokens are AES-256-GCM encrypted via Phase B's `encryptSecret`/`decryptSecret`, stored in `user_settings`, decrypted server-side only, never returned to the client.
- Service-role admin-client reads/writes of tenant data filter `.eq("user_id", userId)` (Phase A/B convention); RLS-enforced-client actions rely on RLS.
- No app-level env vars are needed for this phase (no App Client, no client secret) — that's specifically an OAuth-only requirement, deferred.
- Working dir is the worktree `.worktrees/multi-tenant` on branch `multi-tenant`. Read `node_modules/next/dist/docs/` before writing Next.js code (per AGENTS.md).
- Verification: this phase has no new pure logic to unit-test (token storage and the Buffer GraphQL calls are thin, live-API-dependent glue, same as Phase B's `user-secrets.ts`) — verified via `npm run build` + `npm test` (suite stays green) + the real end-to-end acceptance test in Task 6. Do not write tests that assert nothing.

## File Structure

- `supabase/migrations/0007_buffer_token.sql` — add `buffer_token_enc` to `user_settings` (create)
- `lib/types.ts` — `BufferChannel` type; remove `buffer_account` from `Category` (modify, split across Tasks 1 and 5 — see each task)
- `lib/settings/buffer.ts` — token store/status/disconnect/`getValidBufferToken` + `getBufferChannels` (create)
- `app/(app)/config/buffer-section.tsx` — paste-key UI (create)
- `app/(app)/config/actions.ts` — `saveBufferToken`/`disconnectBufferAction`; category actions gain `buffer_channel_id`/`post_caption` (modify)
- `app/(app)/config/category-manager.tsx` — channel dropdown + caption field (modify)
- `app/(app)/config/page.tsx` — fetch Buffer status + channels, render the section (modify)
- `lib/athena/buffer.ts` — `postToBuffer` takes a token directly (modify)
- `lib/athena/carousel.ts` — remove `bufferTokenFor` (modify)
- `tests/carousel.test.ts` — drop the `bufferTokenFor` tests (modify)
- `app/api/posts/create/route.ts` — use the user's stored token (modify)

---

### Task 1: Migration + types

**Files:**
- Create: `supabase/migrations/0007_buffer_token.sql`
- Modify: `lib/types.ts`

**Interfaces:**
- Produces: `user_settings.buffer_token_enc`; `BufferChannel` type.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0007_buffer_token.sql
-- Phase C: per-user Buffer personal API key (BYOK — same pattern as the
-- Anthropic/Kie keys from migration 0006). OAuth is a deferred future
-- upgrade; see docs/superpowers/plans/2026-07-23-multi-tenant-phase-c-buffer-oauth.md.
-- getValidBufferToken() in lib/settings/buffer.ts is the abstraction boundary
-- that lets that upgrade land later without touching any of its callers.

alter table user_settings add column buffer_token_enc text not null default '';
```

- [ ] **Step 2: USER STEP — apply the migration**

The controller must have Rayyan run `0007_buffer_token.sql` in the Supabase SQL editor before Task 2+ can be live-verified.

- [ ] **Step 3: Add `BufferChannel` to `lib/types.ts`**

Append only — do not touch `Category` in this task (`buffer_account` is removed later, in Task 5, together with its last reader, to keep every commit's build green).

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

Run: `npm run build` → SUCCESS (additive only).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_buffer_token.sql lib/types.ts
git commit -m "feat: migration 0007 - buffer_token_enc column; BufferChannel type"
```

---

### Task 2: Buffer settings module (store, status, disconnect, channel listing)

**Files:**
- Create: `lib/settings/buffer.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (Phase B), `createAdminSupabase`, `BufferChannel` (Task 1).
- Produces:
  - `storeBufferToken(userId: string, token: string): Promise<void>`
  - `getBufferStatus(userId: string): Promise<{ connected: boolean }>`
  - `disconnectBuffer(userId: string): Promise<void>`
  - `getValidBufferToken(userId: string): Promise<string>` — throws `Error("Add your Buffer personal key in Config")` if unset. **This is the stable call site every later task uses.**
  - `getBufferChannels(userId: string): Promise<BufferChannel[]>`

- [ ] **Step 1: Implement `lib/settings/buffer.ts`**

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
import type { BufferChannel } from "@/lib/types";

interface BufferRow {
  buffer_token_enc: string;
}

async function fetchBufferRow(userId: string): Promise<BufferRow | null> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("user_settings")
    .select("buffer_token_enc")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_settings query failed: ${error.message}`);
  return (data as BufferRow) ?? null;
}

export async function storeBufferToken(userId: string, token: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("user_settings").upsert(
    { user_id: userId, buffer_token_enc: encryptSecret(token) },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`failed to store buffer token: ${error.message}`);
}

export async function getBufferStatus(userId: string): Promise<{ connected: boolean }> {
  const row = await fetchBufferRow(userId);
  return { connected: !!row?.buffer_token_enc };
}

export async function disconnectBuffer(userId: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from("user_settings")
    .update({ buffer_token_enc: "" })
    .eq("user_id", userId);
  if (error) throw new Error(`failed to disconnect buffer: ${error.message}`);
}

// The one function every downstream Buffer call goes through — the stable
// boundary that lets a future OAuth upgrade add expiry/refresh logic here
// without touching postToBuffer, getBufferChannels, or the posting route.
export async function getValidBufferToken(userId: string): Promise<string> {
  const row = await fetchBufferRow(userId);
  if (!row?.buffer_token_enc) throw new Error("Add your Buffer personal key in Config");
  return decryptSecret(row.buffer_token_enc);
}

const GRAPHQL_URL = "https://api.buffer.com";

async function bufferGraphQL<T>(token: string, query: string): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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

- [ ] **Step 2: Verify build** (`npm run build` → SUCCESS).

- [ ] **Step 3: Commit**

```bash
git add lib/settings/buffer.ts
git commit -m "feat: buffer personal-key store/status/disconnect + channel listing"
```

---

### Task 3: Config Buffer section (paste-key UI)

**Files:**
- Modify: `app/(app)/config/actions.ts` (add `saveBufferToken`, `disconnectBufferAction`)
- Create: `app/(app)/config/buffer-section.tsx`
- Modify: `app/(app)/config/page.tsx` (fetch status, render section)

**Interfaces:**
- Consumes: `storeBufferToken`, `disconnectBuffer`, `getBufferStatus` (Task 2), `requireUser`.
- Produces: a Buffer card on `/config` with connect/disconnect, matching the Keys/Brand section conventions already on that page.

- [ ] **Step 1: Add actions to `app/(app)/config/actions.ts`**

Add the import and both actions:

```ts
import { storeBufferToken, disconnectBuffer } from "@/lib/settings/buffer";

export async function saveBufferToken(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  const token = String(formData.get("token") ?? "").trim();
  if (!token) return { error: "Enter a Buffer personal key." };
  try {
    await storeBufferToken(user.id, token);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/config");
  return { ok: true };
}

export async function disconnectBufferAction() {
  const user = await requireUser();
  await disconnectBuffer(user.id);
  revalidatePath("/config");
}
```

(Unlike `saveApiKeys`'s two-field "blank means keep" form, this is a single-field form — an empty submit is treated as a validation error, not a silent no-op, since there's no second field to preserve.)

- [ ] **Step 2: Implement `app/(app)/config/buffer-section.tsx`**

```tsx
"use client";
import { useActionState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { saveBufferToken, disconnectBufferAction } from "./actions";

export function BufferSection({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveBufferToken, undefined);
  const [disconnecting, startDisconnect] = useTransition();

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
        <form action={action} className="space-y-2">
          <div>
            <Label>Buffer personal key</Label>
            <Input
              name="token"
              type="password"
              placeholder={connected ? "•••••••• (leave blank to keep, or type a new one)" : "Paste your Buffer personal key"}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Get this from Buffer → Settings → API → Personal Keys.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
            {connected && (
              <Button
                type="button"
                variant="outline"
                disabled={disconnecting}
                onClick={() => startDisconnect(async () => {
                  await disconnectBufferAction();
                  router.refresh();
                })}
              >
                Disconnect
              </Button>
            )}
            {state?.ok && <span className="text-sm text-status-success">Saved.</span>}
            {state?.error && <span className="text-sm text-destructive">{state.error}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Wire into `app/(app)/config/page.tsx`**

Add the import and status fetch, render the section (placement: after `BrandSection`, before `CategoryManager` — Task 4 also touches this render order):

```tsx
import { getBufferStatus } from "@/lib/settings/buffer";
import { BufferSection } from "./buffer-section";
// ...inside the component, after the existing key/brand fetches:
  const bufferStatus = await getBufferStatus(user.id);
// ...in JSX, after <BrandSection .../>:
      <BufferSection connected={bufferStatus.connected} />
```

- [ ] **Step 4: Verify build + suite**

Run: `npm run build && npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config"
git commit -m "feat: Buffer personal-key connect/disconnect UI on /config"
```

---

### Task 4: Category manager — channel picker + caption

**Files:**
- Modify: `app/(app)/config/actions.ts` (extend `CategoryFields`, create/update payloads)
- Modify: `app/(app)/config/category-manager.tsx` (channel dropdown + caption field)
- Modify: `app/(app)/config/page.tsx` (fetch channels, pass to `CategoryManager`)

**Interfaces:**
- Consumes: `getBufferChannels` (Task 2), `BufferChannel` (Task 1).
- Produces: category editor with a `post_caption` field and a `buffer_channel_id` dropdown sourced from the user's real connected channels.

- [ ] **Step 1: Extend `CategoryFields` and the category actions in `app/(app)/config/actions.ts`**

Add `buffer_channel_id: string;` and `post_caption: string;` to `CategoryFields`. Include both in the `createCategory` insert and `updateCategory` update payloads.

- [ ] **Step 2: Extend `app/(app)/config/category-manager.tsx`**

Add `buffer_channel_id: ""` and `post_caption: ""` to `EMPTY` and to the edit-mode initializer (pull from `category.buffer_channel_id`/`category.post_caption`). Accept `channels: BufferChannel[]` on both `CategoryManager` and `CategoryEditor`, threading it through. In the editor JSX, after the aspect-ratio grid:

```tsx
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

Import `BufferChannel` from `@/lib/types` and `Textarea` if not already imported (it already is, for `style_guide`/`output_format`).

- [ ] **Step 3: Fetch channels in `app/(app)/config/page.tsx`**

```tsx
import { getBufferChannels } from "@/lib/settings/buffer";
import type { BufferChannel } from "@/lib/types";
// ...after the bufferStatus fetch:
  let channels: BufferChannel[] = [];
  if (bufferStatus.connected) {
    try { channels = await getBufferChannels(user.id); } catch { channels = []; }
  }
// ...pass to the manager:
      <CategoryManager categories={...} channels={channels} />
```

(Tolerating a fetch failure to `[]` means a bad/revoked key doesn't hard-fail the whole config page — it just shows the "Connect Buffer above" hint.)

- [ ] **Step 4: Verify build + suite + manual**

Run: `npm run build && npm test` → green.
Manual (needs migration 0007 applied and a real Buffer personal key pasted in): category editor shows the caption field and, once connected, a dropdown of real channel names.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config"
git commit -m "feat: category caption + Buffer channel picker"
```

---

### Task 5: Posting rework — use the user's stored token

**Files:**
- Modify: `lib/athena/buffer.ts`
- Modify: `lib/athena/carousel.ts`
- Modify: `tests/carousel.test.ts`
- Modify: `app/api/posts/create/route.ts`
- Modify: `lib/types.ts` (remove `buffer_account` from `Category`)

**Interfaces:**
- Consumes: `getValidBufferToken` (Task 2).
- Produces: `postToBuffer(token: string, channelId: string, imageUrls: string[], caption: string)`; posting scoped to the acting user's own Buffer key.

- [ ] **Step 1: Change `postToBuffer` in `lib/athena/buffer.ts` to take a token directly**

```ts
import "server-only";
import { buildCreatePostMutation } from "./carousel";

export interface BufferResult { success: boolean; postId: string; error: string; rawBody: string; }

export async function postToBuffer(
  token: string,
  channelId: string,
  imageUrls: string[],
  caption: string,
): Promise<BufferResult> {
  const body = buildCreatePostMutation(channelId, imageUrls, caption);
  const res = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // ...rest of the parsing/return logic (rawBody, postId/error extraction, return) is unchanged...
}
```

Remove the `bufferTokenFor` import.

- [ ] **Step 2: Remove `bufferTokenFor` from `lib/athena/carousel.ts`**

Delete the `bufferTokenFor` function entirely. `pickCaption`, `selectAutoFill`, `buildCreatePostMutation`, and the `Postable` interface stay unchanged.

- [ ] **Step 3: Drop the `bufferTokenFor` tests from `tests/carousel.test.ts`**

Remove the `describe("bufferTokenFor", ...)` block and its `afterEach` for `BUFFER_TOKEN_*`, and the now-unused `bufferTokenFor` import. Keep every other test.

- [ ] **Step 4: Update `app/api/posts/create/route.ts`**

Add the import and replace the `postToBuffer` call site:

```ts
import { getValidBufferToken } from "@/lib/settings/buffer";
// ...replace the try/catch around postToBuffer:
  let result;
  try {
    const token = await getValidBufferToken(user.id);
    result = await postToBuffer(token, cat.buffer_channel_id, imageUrls, caption);
  } catch (e) {
    result = { success: false, postId: "", error: e instanceof Error ? e.message : String(e), rawBody: "" };
  }
```

(If the user hasn't added a Buffer key, `getValidBufferToken` throws "Add your Buffer personal key in Config", caught here and surfaced as the post failure reason — same path as any other Buffer error.)

- [ ] **Step 5: Remove `buffer_account` from `Category` in `lib/types.ts`**

Delete the `buffer_account: 1 | 2;` line. Confirm no remaining references:

Run: `grep -rn "buffer_account\|bufferTokenFor\|BUFFER_TOKEN" app lib` — expected: no matches.

- [ ] **Step 6: Verify build + suite**

Run: `npm run build && npm test` → green.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/buffer.ts lib/athena/carousel.ts tests/carousel.test.ts app/api/posts/create/route.ts lib/types.ts
git commit -m "feat: posting uses each user's Buffer personal key; drop shared-token routing"
```

---

### Task 6: Deploy + production acceptance (user-assisted)

**Files:** none (operational — run by the controller with Rayyan).

- [ ] **Step 1: Apply migration + push**

Confirm migration `0007_buffer_token.sql` is applied (Task 1, if not already). Push the branch so the preview redeploys. No new env vars are needed for this phase (no client ID/secret — that's OAuth-only).

- [ ] **Step 2: Acceptance test (Rayyan, on the preview deployment)**

1. `/config` → Buffer section shows "not connected." Go to Buffer's dashboard → Settings → API → Personal Keys, generate a key, paste it in, Save → badge flips to "connected."
2. A category's editor now shows a channel dropdown populated with real connected channels; pick one, add a caption, save.
3. Generate/approve an idea → image → on `/post`, post a carousel for that category → confirm it lands in the correct channel's Buffer queue, History shows `queued`, ideas flip to `posted`.
4. Test Disconnect: click it, confirm the badge flips back and posting now fails with the "Add your Buffer personal key" message until reconnected.

- [ ] **Step 3: If the channel query shape was wrong**

If Step 2 shows no channels despite a connected key, correct the GraphQL query/response path in `getBufferChannels` (Task 2) against Buffer's live API — same class of fix as any doc-derived-but-unverified API detail.

---

## Phase C completion

After Task 6 passes: each user pastes their own Buffer personal key, picks from their own real channels, and posts to their own queue — `/post` is fully tenant-safe. That completes "minimum usable" for the beta (Phases A+B+C): a friend can sign up, bring their keys, define their brand + categories, generate on-brand content, connect Buffer, and post — all isolated. Phase D (usage caps + a polished Setup status page) remains optional polish. The OAuth upgrade path (App Client, PKCE, refresh-token rotation) stays documented and ready at `docs/superpowers/plans/2026-07-23-multi-tenant-phase-c-buffer-oauth.md` for whenever this moves beyond a friends-beta.
