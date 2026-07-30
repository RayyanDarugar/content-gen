# MCP Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose content-gen-app's post-authoring functionality as a remote MCP server so Claude Code (via a Claude Code plugin, the same shape as the `agent-authoring` plugin) can create/manage brand context, post types, ideas, and scheduled posts directly, without a human driving the browser UI.

**Architecture:** A single Next.js route (`app/api/mcp/route.ts`) hosts a stateless remote MCP server (via `mcp-handler`), authenticated per-request by a bearer API token (new `api_tokens` table) instead of the browser's Supabase session cookie. Every mutation the browser UI can already trigger gets pulled out of its route handler / server action into a small `*ForUser(userId, ...)` function that takes an explicit `userId` and talks to Supabase via the existing service-role admin client — mirroring the pattern `lib/athena/generate-ideas.ts`, `lib/athena/submit-generations.ts`, and `lib/settings/buffer.ts` already use. Both the cookie-authenticated browser route/action AND the new bearer-token-authenticated MCP tool call that same core function, so business logic is never duplicated. Tools are tiered: **Tier 1** (reversible/safe) register with no extra gate; **Tier 2** (irreversible, costs money, or reaches a live external account) require an explicit `confirm: true` argument enforced server-side, and their tool descriptions instruct the calling agent to show the user what will happen and get explicit go-ahead before setting it. There is no Tier 3 — the one genuinely irreversible external action (Buffer publish/schedule) is exposed as `schedule_post`, but only in confirm-gated form and only when a future `scheduled_at` is supplied.

**Tech Stack:** Next.js 16.2.10 (App Router, existing `route.ts` handlers), Supabase (`@supabase/supabase-js`), `mcp-handler` (new dependency, MCP TypeScript SDK wrapper built for exactly this deployment shape — stateless serverless HTTP, no Redis needed), `zod` (already ^4.4.3, satisfies `mcp-handler`'s peer requirement), vitest.

## Global Constraints

- Follow the codebase's existing convention: thin `route.ts` handlers that parse/validate input and delegate to a plain, testable function — apply this to the four routes that don't yet follow it (`brand/extract`, `posts/rewrite-caption`, `posts/adapt-caption`, `categories/draft`, `posts/create`).
- Every extracted core function takes an explicit `userId: string` as its first argument and uses `createAdminSupabase()` + `.eq("user_id", userId)` filtering — never `createServerSupabase()` (cookie-scoped) — so it works identically whether called from a cookie session or a bearer token.
- The browser UI's cookie-session auth (`createServerSupabase()`, `requireUser()`) is untouched for existing call sites. `requireUser()` gains an **optional** `request` parameter; existing no-arg call sites are unaffected.
- New dependency: `mcp-handler` (`npm install mcp-handler`). Before writing Task 8's tool-registration code, read `node_modules/mcp-handler/README.md` (or its type defs) to confirm `registerTool`'s exact signature against the installed version — treat the code in this plan as the expected shape, not gospel, per this repo's AGENTS.md instruction to verify library behavior against what's actually installed rather than training-data memory.
- Tier 2 tools (`delete_category`, `remove_buffer_connection`, `submit_image_generation`, `resubmit_slide`, `schedule_post`) must reject any call missing `confirm: true` with a clear error, before touching the database or any external API.
- `schedule_post` must reject any call missing `scheduled_at` or with `scheduled_at` in the past — there is deliberately no "queue immediately" MCP tool.
- No new table skips Row Level Security — every new table gets `enable row level security` plus an "owner all" policy, matching every existing table (the service-role client bypasses RLS by design; this is defense in depth, not the primary access control).

---

### Task 1: API token issuance and verification

**Files:**
- Create: `supabase/migrations/0018_api_tokens.sql`
- Create: `lib/auth/api-tokens.ts`
- Modify: `lib/auth/require-user.ts`
- Test: `tests/api-tokens.test.ts`

**Interfaces:**
- Produces: `generateApiToken(): { token: string; hash: string }`, `hashToken(token: string): string`, `createApiTokenForUser(userId: string, label: string): Promise<{ id: string; token: string }>`, `verifyApiToken(token: string): Promise<{ userId: string; tokenId: string } | null>`, `listApiTokensForUser(userId: string): Promise<{ id: string; label: string; created_at: string; last_used_at: string | null }[]>`, `revokeApiTokenForUser(userId: string, tokenId: string): Promise<void>`
- Produces: `requireUser(request?: NextRequest): Promise<User>` (extended signature — existing no-arg callers unaffected)

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0018_api_tokens.sql
-- Bearer credential for non-browser callers (MCP agent integration) — a
-- separate credential from the Supabase session cookie the browser UI uses.
-- Only the sha256 hash is stored; the raw token is shown once at creation
-- and is not recoverable.

create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index api_tokens_user_id_idx on api_tokens(user_id);

alter table api_tokens enable row level security;
create policy "owner all" on api_tokens
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/api-tokens.test.ts
import { describe, expect, it } from "vitest";
import { generateApiToken, hashToken } from "@/lib/auth/api-tokens";

describe("generateApiToken", () => {
  it("produces a token whose hash matches hashToken", () => {
    const { token, hash } = generateApiToken();
    expect(token.startsWith("cga_")).toBe(true);
    expect(hashToken(token)).toBe(hash);
  });

  it("produces different tokens on each call", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.token).not.toBe(b.token);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/api-tokens.test.ts`
Expected: FAIL — `Cannot find module '@/lib/auth/api-tokens'`

- [ ] **Step 4: Implement `lib/auth/api-tokens.ts`**

```typescript
import "server-only";
import { randomBytes, createHash } from "crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";

const TOKEN_PREFIX = "cga_"; // content-gen-app

export function generateApiToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createApiTokenForUser(
  userId: string,
  label: string,
): Promise<{ id: string; token: string }> {
  const { token, hash } = generateApiToken();
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("api_tokens")
    .insert({ user_id: userId, label: label.trim() || "Untitled token", token_hash: hash })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "failed to create token");
  return { id: data.id as string, token };
}

export async function verifyApiToken(token: string): Promise<{ userId: string; tokenId: string } | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const supabase = createAdminSupabase();
  const hash = hashToken(token);
  const { data, error } = await supabase
    .from("api_tokens")
    .select("id, user_id")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error || !data) return null;
  // Best-effort — a failed last_used_at write must never fail authentication.
  await supabase.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return { userId: data.user_id as string, tokenId: data.id as string };
}

export async function listApiTokensForUser(userId: string) {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("api_tokens")
    .select("id, label, created_at, last_used_at") // never token_hash
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function revokeApiTokenForUser(userId: string, tokenId: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("api_tokens").delete().eq("id", tokenId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/api-tokens.test.ts`
Expected: PASS

- [ ] **Step 6: Extend `requireUser` to accept a bearer token**

```typescript
// lib/auth/require-user.ts
import "server-only";
import type { User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { verifyApiToken } from "@/lib/auth/api-tokens";

// A request-scoped MCP caller has no Supabase session — only an id. Every
// existing call site only ever reads `.id`, so a minimal stub satisfies the
// User type without pretending to have a real Supabase auth session.
function stubUser(id: string): User {
  return { id, app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "" } as User;
}

export async function requireUser(request?: NextRequest): Promise<User> {
  const bearer = request?.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) {
    const verified = await verifyApiToken(bearer.slice("Bearer ".length));
    if (!verified) throw new Error("unauthorized");
    return stubUser(verified.userId);
  }
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");
  return user;
}
```

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (no existing caller passes a `request` argument, so behavior for them is unchanged)

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0018_api_tokens.sql lib/auth/api-tokens.ts lib/auth/require-user.ts tests/api-tokens.test.ts
git commit -m "feat: add bearer API tokens for non-browser callers"
```

---

### Task 2: Token management (create / list / revoke)

**Files:**
- Modify: `app/(app)/config/actions.ts`

**Interfaces:**
- Consumes: `createApiTokenForUser`, `listApiTokensForUser`, `revokeApiTokenForUser` from Task 1
- Produces: `createApiToken(label: string): Promise<{ token?: string; error?: string }>`, `listApiTokens(): Promise<{ id: string; label: string; created_at: string; last_used_at: string | null }[]>`, `revokeApiToken(tokenId: string): Promise<void>`

- [ ] **Step 1: Add the actions**

```typescript
// app/(app)/config/actions.ts — add alongside the other exports
import { createApiTokenForUser, listApiTokensForUser, revokeApiTokenForUser } from "@/lib/auth/api-tokens";

export async function createApiToken(label: string): Promise<{ token?: string; error?: string }> {
  const user = await requireUser();
  try {
    const { token } = await createApiTokenForUser(user.id, label);
    revalidatePath("/config");
    return { token };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listApiTokens() {
  const user = await requireUser();
  return listApiTokensForUser(user.id);
}

export async function revokeApiToken(tokenId: string): Promise<void> {
  const user = await requireUser();
  await revokeApiTokenForUser(user.id, tokenId);
  revalidatePath("/config");
}
```

This plan does not include a dedicated UI panel — wire a minimal "API tokens" section into the existing config page only if you want to mint tokens without a REPL. In the meantime a token can be minted by calling `createApiToken` from a one-off script (`npx tsx` against the deployed environment, using `createServerSupabase`'s equivalent admin path) or a temporary debug button. If you want the UI panel built, that's a follow-up task, not blocking anything below.

- [ ] **Step 2: Commit**

```bash
git add "app/(app)/config/actions.ts"
git commit -m "feat: add API token create/list/revoke actions"
```

---

### Task 3: Extract categories + brand-profile core logic

**Files:**
- Modify: `app/(app)/config/actions.ts`
- Modify: `app/api/brand/extract/route.ts`

**Interfaces:**
- Produces: `createCategoryForUser(userId: string, fields: CategoryFields): Promise<void>`, `updateCategoryForUser(userId: string, id: string, fields: CategoryFields): Promise<void>`, `deleteCategoryForUser(userId: string, id: string): Promise<void>`, `clearRoleRefUrlForUser(userId: string, categoryId: string, role: "hook" | "beat" | "payoff" | "single"): Promise<void>`, `saveBrandProfileForUser(userId: string, fields: { business_name: string; business_description: string; audience: string; voice: string; avoid: string; proof_points: string[]; standing: string[]; colors: string[]; fonts: string[]; visual_notes: string }): Promise<void>`
- Produces: `extractBrandProfileForUser(userId: string, input: { url: string | null; documentUrls: string[]; turns: { role: "user" | "assistant"; text: string }[] }): Promise<Record<string, unknown> & { warnings: string[] }>`

Note: `createCategory`/`updateCategory`/`deleteCategory`/`clearRoleRefUrl` currently use `createServerSupabase()` (RLS-scoped, filters implicitly by session). The extracted `*ForUser` versions switch to `createAdminSupabase()` with an explicit `.eq("user_id", userId)` — this is a deliberate, load-bearing change: without the explicit filter, `updateCategoryForUser`/`deleteCategoryForUser` called with the admin client and no `user_id` predicate would touch **any** user's row by id. Every write below adds `.eq("user_id", userId)` even though the current RLS-scoped versions rely on the policy alone.

- [ ] **Step 1: Add the core functions, keep the actions as thin wrappers**

```typescript
// app/(app)/config/actions.ts

export async function createCategoryForUser(userId: string, fields: CategoryFields): Promise<void> {
  validateCategoryFields(fields);
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("categories").insert({
    user_id: userId,
    key: slugify(fields.name),
    name: fields.name,
    style_guide: fields.style_guide,
    output_format: fields.output_format,
    style_ref_url: fields.style_ref_url,
    post_caption: fields.post_caption,
    buffer_channel_id: fields.buffer_channel_id,
    buffer_connection_id: fields.buffer_connection_id || null,
    caption_guide: fields.caption_guide,
    buffer_channel_service: fields.buffer_channel_service,
    images_per_carousel: fields.images_per_carousel,
    post_type: fields.post_type,
    role_guides: fields.role_guides,
    aspect_ratio: fields.aspect_ratio || "4:5",
    active: fields.active,
  });
  if (error) {
    if (error.code === "23505") throw new Error("You already have a category with a similar name");
    throw new Error(error.message);
  }
}

export async function createCategory(fields: CategoryFields) {
  const user = await requireUser();
  await createCategoryForUser(user.id, fields);
  revalidatePath("/config");
}

export async function updateCategoryForUser(userId: string, id: string, fields: CategoryFields): Promise<void> {
  validateCategoryFields(fields);
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("categories").update({
    name: fields.name,
    style_guide: fields.style_guide,
    output_format: fields.output_format,
    style_ref_url: fields.style_ref_url,
    post_caption: fields.post_caption,
    buffer_channel_id: fields.buffer_channel_id,
    buffer_connection_id: fields.buffer_connection_id || null,
    caption_guide: fields.caption_guide,
    buffer_channel_service: fields.buffer_channel_service,
    images_per_carousel: fields.images_per_carousel,
    post_type: fields.post_type,
    role_guides: fields.role_guides,
    aspect_ratio: fields.aspect_ratio || "4:5",
    active: fields.active,
  }).eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function updateCategory(id: string, fields: CategoryFields) {
  const user = await requireUser();
  await updateCategoryForUser(user.id, id, fields);
  revalidatePath("/config");
}

export async function clearRoleRefUrlForUser(
  userId: string, categoryId: string, role: "hook" | "beat" | "payoff" | "single",
): Promise<void> {
  const supabase = createAdminSupabase();
  const { data: category } = await supabase
    .from("categories").select("role_ref_urls").eq("id", categoryId).eq("user_id", userId).maybeSingle();
  if (!category) throw new Error("unknown category");
  const next: RoleRefUrls = { ...(category.role_ref_urls ?? {}) };
  delete next[role];
  const { error } = await supabase.from("categories").update({ role_ref_urls: next })
    .eq("id", categoryId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function clearRoleRefUrl(categoryId: string, role: "hook" | "beat" | "payoff" | "single") {
  const user = await requireUser();
  await clearRoleRefUrlForUser(user.id, categoryId, role);
  revalidatePath("/config");
}

export async function deleteCategoryForUser(userId: string, id: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("categories").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function deleteCategory(id: string) {
  const user = await requireUser();
  await deleteCategoryForUser(user.id, id);
  revalidatePath("/config");
}

interface BrandProfileFields {
  business_name: string; business_description: string; audience: string; voice: string; avoid: string;
  proof_points: string[]; standing: string[]; colors: string[]; fonts: string[]; visual_notes: string;
}

export async function saveBrandProfileForUser(userId: string, fields: BrandProfileFields): Promise<void> {
  if (!fields.business_name.trim()) throw new Error("Give the brand a name.");
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("brand_profiles").upsert(
    { user_id: userId, ...fields },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(error.message);
}

export async function saveBrandProfile(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  try {
    await saveBrandProfileForUser(user.id, {
      business_name: String(formData.get("business_name") ?? "").trim(),
      business_description: String(formData.get("business_description") ?? "").trim(),
      audience: String(formData.get("audience") ?? "").trim(),
      voice: String(formData.get("voice") ?? "").trim(),
      avoid: String(formData.get("avoid") ?? "").trim(),
      proof_points: parseBrandList(formData.get("proof_points")),
      standing: parseBrandList(formData.get("standing")),
      colors: parseBrandList(formData.get("colors")),
      fonts: parseBrandList(formData.get("fonts")),
      visual_notes: String(formData.get("visual_notes") ?? "").trim(),
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/config");
  return { ok: true };
}
```

Add `createAdminSupabase` to the file's imports (`import { createAdminSupabase } from "@/lib/supabase/admin";`).

- [ ] **Step 2: Run the existing test suite and the app's config page manually**

Run: `npx vitest run`
Expected: PASS. Then start the dev server and exercise category create/update/delete and brand profile save from the UI once, to confirm the thin wrappers still behave identically.

- [ ] **Step 3: Extract `brand/extract`'s core logic**

```typescript
// app/api/brand/extract/route.ts — replace the body of POST with a call to
// this new function; keep parsing/400s in the route, move everything from
// "const warnings" onward into the function.
export async function extractBrandProfileForUser(
  userId: string,
  input: { url: string | null; documentUrls: string[]; turns: { role: "user" | "assistant"; text: string }[] },
): Promise<Record<string, unknown> & { warnings: string[] }> {
  const { url, documentUrls, turns } = input;
  const warnings: string[] = [];
  let pageText = "";
  let designCandidates: DesignCandidates | null = null;
  if (url) {
    try {
      const { html, finalUrl } = await fetchPageHtml(url);
      pageText = extractReadableText(html);
      try {
        const sheets = await withDeadline(fetchStylesheets(html, finalUrl), DESIGN_TOKEN_BUDGET_MS, [] as string[]);
        designCandidates = parseDesignCandidates(html, sheets);
      } catch {
        designCandidates = null;
      }
    } catch (e) {
      warnings.push(`Couldn't read ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const documentBlocks: Anthropic.ContentBlockParam[] = [];
  const preflights = await Promise.all(
    documentUrls.map(async (u) => {
      try {
        return { url: u, ...(await preflightDocument(u)), error: null as string | null };
      } catch (e) {
        return { url: u, kind: null, contentType: "", error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  for (const p of preflights) {
    if (p.error) {
      warnings.push(`Couldn't read ${p.url}: ${p.error}`);
    } else if (p.kind === "document") {
      documentBlocks.push({ type: "document", source: { type: "url", url: p.url } });
    } else if (p.kind === "image") {
      documentBlocks.push({ type: "image", source: { type: "url", url: p.url } });
    } else {
      warnings.push(`Couldn't read ${p.url}: unsupported type (${p.contentType || "unknown"})`);
    }
  }

  const content: Anthropic.ContentBlockParam[] = [
    ...documentBlocks,
    ...(designCandidates && (designCandidates.colors.length || designCandidates.fonts.length)
      ? [{ type: "text" as const, text: `DESIGN CANDIDATES (unjudged, ranked):\n${JSON.stringify(designCandidates)}` }]
      : []),
    ...(pageText ? [{ type: "text" as const, text: `WEBSITE TEXT (${url}):\n${pageText}` }] : []),
    ...(turns.length
      ? [{ type: "text" as const, text: `WHAT THE USER TOLD YOU:\n${turns.map((t) => `${t.role}: ${t.text}`).join("\n")}` }]
      : []),
  ];
  if (!content.length) throw new Error(warnings[0] ?? "Nothing readable was provided.");

  const anthropic = createAnthropicClient({ apiKey: await requireAnthropicKey(userId), feature: "brand_analysis", maxRetries: 5 });
  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: buildBrandExtractSystemPrompt(),
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(BrandExtractOutput) },
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`extraction returned no parseable output (stop_reason: ${response.stop_reason})`);
  return { ...parsed, warnings };
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : null;
  const documentUrls: string[] = Array.isArray(body?.documentUrls)
    ? body.documentUrls.filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://")).slice(0, 5)
    : [];
  const turns: { role: "user" | "assistant"; text: string }[] = Array.isArray(body?.turns)
    ? body.turns.filter((t: unknown) => {
        const turn = t as { role?: unknown; text?: unknown };
        return (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string";
      })
    : [];
  if (!url && !documentUrls.length && !turns.length) {
    return NextResponse.json({ error: "Give it something to read — a website, a document, or a description." }, { status: 400 });
  }
  try {
    const result = await extractBrandProfileForUser(user.id, { url, documentUrls, turns });
    return NextResponse.json(result);
  } catch (e) {
    console.error("brand extraction failed:", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the test suite and exercise brand extraction manually once**

Run: `npx vitest run`
Expected: PASS. Then trigger a brand extraction from the config page against a real URL once, to confirm the refactor didn't change behavior.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config/actions.ts" app/api/brand/extract/route.ts
git commit -m "refactor: extract userId-parameterized core logic for categories and brand profile"
```

---

### Task 4: Extract ideas core logic

**Files:**
- Modify: `app/(app)/ideas/actions.ts`

**Interfaces:**
- Produces: `setIdeaDecisionForUser(userId: string, id: string, decision: "approved" | "rejected"): Promise<void>`, `createManualIdeaForUser(userId: string, input: { categoryKey: string; concept: string; slides: Slide[]; postText?: string }): Promise<void>`

- [ ] **Step 1: Extract and wrap**

```typescript
// app/(app)/ideas/actions.ts
import { createAdminSupabase } from "@/lib/supabase/admin";

export async function setIdeaDecisionForUser(
  userId: string, id: string, decision: "approved" | "rejected",
): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from("ideas")
    .update({ approved: decision === "approved", status: decision })
    .eq("id", id)
    .eq("user_id", userId)
    .in("status", ["pending_review", "approved", "rejected"]);
  if (error) throw new Error(error.message);
}

export async function setIdeaDecision(id: string, decision: "approved" | "rejected") {
  const user = await requireUser();
  await setIdeaDecisionForUser(user.id, id, decision);
  revalidatePath("/ideas");
}

export async function createManualIdeaForUser(
  userId: string,
  input: { categoryKey: string; concept: string; slides: Slide[]; postText?: string },
): Promise<void> {
  const supabase = createAdminSupabase();
  const shape = validateSlideShape(input.slides, input.slides.length);
  if (!shape.ok) throw new Error(shape.reason);
  if (!input.concept.trim()) throw new Error("concept is required");

  const { data: category } = await supabase
    .from("categories").select("key, post_type").eq("key", input.categoryKey).eq("user_id", userId).maybeSingle();
  if (!category) throw new Error(`unknown category ${input.categoryKey}`);

  if (category.post_type === "independent" && input.slides.length > 1) {
    console.warn(
      `createManualIdea: ${input.slides.length}-slide idea for independent category ` +
        `"${input.categoryKey}" — its style guide will apply unchanged to every panel.`,
    );
  }

  const { error } = await supabase.from("ideas").insert({
    user_id: userId,
    category_key: input.categoryKey,
    concept: input.concept,
    resolved_prompt: "",
    ai_filter_reason: "",
    approved: true,
    status: "approved",
    batch_id: randomUUID(),
    slides: input.slides,
    post_text: input.postText?.trim() ?? "",
  });
  if (error) throw new Error(error.message);
}

export async function createManualIdea(input: {
  categoryKey: string; concept: string; slides: Slide[]; postText?: string;
}): Promise<void> {
  const user = await requireUser();
  await createManualIdeaForUser(user.id, input);
  revalidatePath("/ideas");
}
```

- [ ] **Step 2: Run the test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/ideas/actions.ts"
git commit -m "refactor: extract userId-parameterized core logic for idea decisions and manual ideas"
```

---

### Task 5: Extract `posts/create` core logic

**Files:**
- Modify: `app/api/posts/create/route.ts`

**Interfaces:**
- Consumes: `postToBuffer`, `getBufferTokenForConnection`, `findWrongAnchorGenerationIds`, `postedSlideIndexesByIdea`, `mediaForPlatform`, `normalizeService`, `summarizeFanOut`, `sentSlidesByIdea` (all unchanged, already imported in the file)
- Produces: `createPostForUser(userId: string, input: { categoryKey: string; generationIds: string[]; channels: ChannelInput[]; caption: string; scheduledAt: string | null; postGroupId: string | null }): Promise<{ postGroupId: string; results: ChannelResult[]; allFailed: boolean }>`

This is a mechanical move: everything from `const postGroupId = ...` through the final `return NextResponse.json(...)` in the current handler becomes the body of `createPostForUser`, taking `userId` where the handler used to read `user.id`, and returning `{ postGroupId, results, allFailed: summary.allFailed }` instead of calling `NextResponse.json`. The route handler keeps all request parsing/validation (the `categoryKey`/`generationIds`/`channelsInput`/`scheduledAt` checks) and the category/generation/sibling lookups that read data needed to validate before calling the core function, since those lookups also do 400-vs-500 shaping the MCP tool needs (Task 11 duplicates the same validation the route already has, so keep both call sites doing their own validation rather than trying to share partially-validated state across a function boundary).

- [ ] **Step 1: Move the mutation body into `createPostForUser`**

```typescript
// app/api/posts/create/route.ts — add this function, taking everything the
// existing handler already computed (category, gens, ordered, imageUrls,
// singleIdeaId, siblings, ideaIds, uniqueIdeaIds) as parameters so the two
// callers (this route, and the future schedule_post tool) can each do their
// own validation/lookups first, then hand off to the same write path.
export async function createPostForUser(
  userId: string,
  args: {
    categoryKey: string;
    postGroupId: string;
    channels: ChannelInput[];
    baseCaption: string;
    scheduledAt: string | null;
    suppliedPostGroupId: string | null;
    ordered: (Generation & { idea: Idea })[];
    imageUrls: string[];
    singleIdeaId: string | null;
    siblings: Pick<Generation, "id" | "idea_id" | "slide_index" | "anchor_generation_id" | "status" | "created_at">[];
    gens: (Generation & { idea: Idea })[];
    uniqueIdeaIds: string[];
  },
): Promise<{ postGroupId: string; results: ChannelResult[]; allFailed: boolean }> {
  const {
    categoryKey, postGroupId, channels, baseCaption, scheduledAt, suppliedPostGroupId,
    ordered, imageUrls, singleIdeaId, siblings, gens, uniqueIdeaIds,
  } = args;
  const supabase = createAdminSupabase();

  const results: ChannelResult[] = [];
  const channelOutcomes: { service: string; queued: boolean }[] = [];
  for (const ch of channels) {
    const urls = mediaForPlatform(imageUrls, normalizeService(ch.service));
    if (suppliedPostGroupId) {
      const { error: cleanupErr } = await supabase
        .from("posts")
        .delete()
        .eq("post_group_id", suppliedPostGroupId)
        .eq("buffer_channel_id", ch.channelId)
        .eq("user_id", userId)
        .eq("status", "failed");
      if (cleanupErr) console.error("posts/create: failed to clean up prior failed row before retry:", cleanupErr.message);
    }

    let r: { success: boolean; postId: string; error: string; rawBody: string };
    try {
      const token = await getBufferTokenForConnection(userId, ch.connectionId);
      r = await postToBuffer(token, ch.channelId, urls, ch.caption, scheduledAt ?? undefined);
    } catch (e) {
      r = { success: false, postId: "", error: e instanceof Error ? e.message : String(e), rawBody: "" };
    }
    channelOutcomes.push({ service: ch.service, queued: r.success });

    const { data: postRow, error: postErr } = await supabase
      .from("posts")
      .insert({
        user_id: userId,
        category_key: categoryKey,
        post_group_id: postGroupId,
        buffer_update_id: r.success ? r.postId : "",
        buffer_channel_id: ch.channelId,
        buffer_channel_service: ch.service,
        caption: ch.caption,
        adapted_from_caption: ch.caption === baseCaption ? "" : baseCaption,
        status: r.success ? "queued" : "failed",
        error: r.success ? "" : (r.error || r.rawBody.slice(0, 2000)),
        idea_id: singleIdeaId,
        scheduled_at: scheduledAt,
      })
      .select()
      .single();
    if (postErr || !postRow) {
      results.push({ channelId: ch.channelId, status: "failed", error: `posted but failed to record: ${postErr?.message}` });
      continue;
    }
    let imagesWarning: string | undefined;
    if (r.success) {
      const images = ordered.slice(0, urls.length).map((g, idx) => ({
        user_id: userId, post_id: postRow.id, generation_id: g.id, sort_order: idx,
      }));
      let imagesErr = (await supabase.from("post_images").insert(images)).error;
      if (imagesErr) imagesErr = (await supabase.from("post_images").insert(images)).error;
      if (imagesErr) {
        console.error(
          "posts/create: post_images insert failed after retry — channel posted but its slides may be offered again:",
          { postId: postRow.id, channelId: ch.channelId, generationIds: images.map((i) => i.generation_id), error: imagesErr.message },
        );
        imagesWarning = "posted but image records failed — this channel's slides may be offered again";
      }
    }
    results.push(
      r.success
        ? { channelId: ch.channelId, status: "queued", bufferUpdateId: r.postId, ...(imagesWarning ? { warning: imagesWarning } : {}) }
        : { channelId: ch.channelId, status: "failed", error: r.error || r.rawBody.slice(0, 500) },
    );
  }

  const summary = summarizeFanOut(results);

  if (summary.queued > 0) {
    const { data: priorImagesData, error: priorImagesErr } = await supabase
      .from("post_images")
      .select("generation_id, post:posts(status, buffer_channel_id)")
      .in("generation_id", siblings.map((s) => s.id))
      .eq("user_id", userId);
    if (priorImagesErr) {
      console.error("posts/create: failed to check prior posted slides:", priorImagesErr.message);
    } else {
      const slideBySiblingId = new Map(siblings.map((s) => [s.id, { idea_id: s.idea_id, slide_index: s.slide_index }]));
      const priorPostedSlidesByIdea = postedSlideIndexesByIdea(
        ((priorImagesData ?? []) as unknown as { generation_id: string; post: { status: string; buffer_channel_id: string } | null }[])
          .map((row): PostedSlideJoinRow | null => {
            const slide = slideBySiblingId.get(row.generation_id);
            return slide && row.post
              ? { post_status: row.post.status, idea_id: slide.idea_id, slide_index: slide.slide_index, buffer_channel_id: row.post.buffer_channel_id }
              : null;
          })
          .filter((row): row is PostedSlideJoinRow => row !== null),
      );
      const submittedSlidesByIdea = sentSlidesByIdea(
        ordered.map((g) => ({ idea_id: g.idea_id, slide_index: g.slide_index })),
        imageUrls,
        channelOutcomes,
      );
      const ideaById = new Map<string, Idea>();
      for (const g of gens) if (!ideaById.has(g.idea_id)) ideaById.set(g.idea_id, g.idea);
      const completedIdeaIds = uniqueIdeaIds.filter((id) => {
        const idea = ideaById.get(id)!;
        const slideCount = (idea.slides ?? []).length || 1;
        const submitted = submittedSlidesByIdea.get(id) ?? new Set<number>();
        const prior = priorPostedSlidesByIdea.get(id) ?? new Set<number>();
        return new Set<number>([...submitted, ...prior]).size === slideCount;
      });
      if (completedIdeaIds.length > 0) {
        const { error: ideaErr } = await supabase.from("ideas").update({ status: "posted" }).in("id", completedIdeaIds).eq("user_id", userId);
        if (ideaErr) console.error("posts/create: failed to mark ideas posted:", ideaErr.message);
      }
    }
  }

  return { postGroupId, results, allFailed: summary.allFailed };
}
```

- [ ] **Step 2: Rewrite `POST` to validate, then delegate**

Replace the body from `const results: ChannelResult[] = []` through the final `return NextResponse.json(...)` with:

```typescript
  const { postGroupId: pg, results, allFailed } = await createPostForUser(user.id, {
    categoryKey, postGroupId, channels, baseCaption, scheduledAt, suppliedPostGroupId,
    ordered, imageUrls, singleIdeaId, siblings, gens, uniqueIdeaIds,
  });
  return NextResponse.json({ postGroupId: pg, results }, { status: allFailed ? 500 : 200 });
```

- [ ] **Step 3: Run the test suite and exercise posting manually once**

Run: `npx vitest run`
Expected: PASS. Then post one real carousel through the composer UI to confirm nothing regressed before this becomes the thing `schedule_post` also calls.

- [ ] **Step 4: Commit**

```bash
git add app/api/posts/create/route.ts
git commit -m "refactor: extract createPostForUser so posting can be called outside the HTTP route"
```

---

### Task 6: Shared brand-context loader

> **DEFERRED (2026-07-30):** `app/api/categories/draft/route.ts` is also being modified right now by a concurrent agent executing `docs/superpowers/plans/2026-07-30-suggested-post-types.md` in its own worktree (`worktree-suggested-post-types`, for suggestion-writeback). Do the `loadBrandContext` extraction and the `rewrite-caption`/`adapt-caption` parts of this task now — skip the `categories/draft` part of Step 5 (the `draftCategoryTurnForUser` extraction) until that other plan has merged to main. Once it has, redo Step 5's `categories/draft` half against the merged file, and only then add the `draft_category_turn` tool row from Task 9's table (it depends on `draftCategoryTurnForUser`).

**Files:**
- Create: `lib/athena/brand-context.ts`
- Modify: `app/api/posts/rewrite-caption/route.ts`
- Modify: `app/api/posts/adapt-caption/route.ts`
- Modify: `app/api/categories/draft/route.ts` (deferred — see note above)
- Test: `tests/brand-context.test.ts`

**Interfaces:**
- Produces: `loadBrandContext(userId: string): Promise<BrandContext>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/brand-context.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { business_name: "Athena", proof_points: ["p1"], colors: ["#fff"] },
          }),
        }),
      }),
    }),
  }),
}));

import { loadBrandContext } from "@/lib/athena/brand-context";

describe("loadBrandContext", () => {
  it("fills in every BrandContext field, defaulting missing ones", async () => {
    const brand = await loadBrandContext("user-1");
    expect(brand.business_name).toBe("Athena");
    expect(brand.proof_points).toEqual(["p1"]);
    expect(brand.voice).toBe("");
    expect(brand.fonts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/brand-context.test.ts`
Expected: FAIL — `Cannot find module '@/lib/athena/brand-context'`

- [ ] **Step 3: Implement it**

```typescript
// lib/athena/brand-context.ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { BrandContext } from "@/lib/athena/prompts";

export async function loadBrandContext(userId: string): Promise<BrandContext> {
  const supabase = createAdminSupabase();
  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").eq("user_id", userId).maybeSingle();
  return {
    business_name: brandRow?.business_name ?? "",
    business_description: brandRow?.business_description ?? "",
    audience: brandRow?.audience ?? "",
    voice: brandRow?.voice ?? "",
    avoid: brandRow?.avoid ?? "",
    proof_points: brandRow?.proof_points ?? [],
    standing: brandRow?.standing ?? [],
    colors: brandRow?.colors ?? [],
    fonts: brandRow?.fonts ?? [],
    visual_notes: brandRow?.visual_notes ?? "",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/brand-context.test.ts`
Expected: PASS

- [ ] **Step 5: Extract `rewrite-caption`, `adapt-caption`, and `categories/draft` to use it**

In each route, swap the `createServerSupabase` import for `createAdminSupabase` (business logic now takes an explicit `userId` and filters manually, per the Global Constraints rule), replace the `const { data: brandRow } = await supabase.from("brand_profiles")...` block and its `const brand: BrandContext = {...}` mapping with `const brand = await loadBrandContext(userId);`, and pull the rest of each handler's logic (everything after the category/idea lookup) into a `*ForUser(userId, input)` function the same way Tasks 3–5 did, so:

```typescript
// app/api/posts/rewrite-caption/route.ts
export async function rewriteCaptionForUser(
  userId: string,
  input: { categoryKey: string; note: string; currentText: string; imageUrls: string[]; ideaId: string | null },
): Promise<{ text: string }> {
  const supabase = createAdminSupabase();
  const { data: catData } = await supabase.from("categories").select("*").eq("key", input.categoryKey).eq("user_id", userId).maybeSingle();
  if (!catData) throw new Error("unknown category");
  const category = catData as Category;

  let idea: Idea | null = null;
  if (input.ideaId) {
    const { data } = await supabase.from("ideas").select("*").eq("id", input.ideaId).eq("user_id", userId).maybeSingle();
    idea = (data as Idea) ?? null;
  }
  const brand = await loadBrandContext(userId);

  const system = [
    "You rewrite the published text of one social post. Return only the rewritten copy.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    `PLATFORM: ${platformPresetFor(category.buffer_channel_service)}`,
    category.caption_guide.trim() ? `COPY GUIDE (wins over the platform note where they conflict):\n${category.caption_guide}` : "",
    idea?.slides?.length ? `THE POST'S SLIDES (for context — do not repeat their text verbatim):\n${JSON.stringify(idea.slides)}` : "",
    "The attached images are the post's actual visuals — the copy may reference what they show.",
  ].filter(Boolean).join("\n");

  const anthropic = createAnthropicClient({ apiKey: await requireAnthropicKey(userId), feature: "post_caption_rewrite" });
  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system,
    messages: [{
      role: "user",
      content: [
        ...input.imageUrls.map((url) => ({ type: "image" as const, source: { type: "url" as const, url } })),
        { type: "text" as const, text: `CURRENT COPY:\n${input.currentText || "(none yet)"}\n\nREWRITE INSTRUCTION:\n${input.note}` },
      ],
    }],
    output_config: { format: zodOutputFormat(RewriteOutput) },
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`rewrite returned no parseable output (stop_reason: ${response.stop_reason})`);
  return { text: parsed.text };
}
```

with `POST` reduced to parsing + `const result = await rewriteCaptionForUser(user.id, { categoryKey, note, currentText, imageUrls, ideaId });` then `NextResponse.json(result)`.

Apply the identical shape to `adapt-caption`, producing:

```typescript
export async function adaptCaptionForUser(
  userId: string,
  input: { categoryKey: string; baseText: string; service: string; ideaId: string | null },
): Promise<{ text: string }>
```

— same category/idea lookups (filtered by `userId`), same `loadBrandContext(userId)` call, body built from `buildAdaptCaptionSystemPrompt(brand, category, input.service)` exactly as the current route does, returning `{ text: parsed.text }`.

And to `categories/draft`, producing:

```typescript
export async function draftCategoryTurnForUser(
  userId: string,
  input: { turns: DraftTurn[]; categoryId: string | null; styleRefUrl: string | null },
): Promise<{ categoryId: string; assistantMessage: string; draft: NormalizedDraft }>
```

— move the `existing` category lookup (filtered by `userId`), the `loadBrandContext(userId)` call, the `anthropic.messages.parse` call, and the existing/insert branching (including the `insertDraft` helper, which already takes `userId` as a parameter and needs no change beyond receiving it from `draftCategoryTurnForUser` instead of the route) into this function unchanged; `POST` keeps only the request parsing/400s and the `isDraftTurn` validation.

- [ ] **Step 6: Run the test suite and exercise all three flows manually once**

Run: `npx vitest run`
Expected: PASS. Then, from the browser UI, rewrite a caption, adapt a caption for a different platform, and run one turn of the category AI wizard — confirm all three still work.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/brand-context.ts app/api/posts/rewrite-caption/route.ts app/api/posts/adapt-caption/route.ts app/api/categories/draft/route.ts tests/brand-context.test.ts
git commit -m "refactor: share a brand-context loader and extract userId-parameterized core logic for caption and draft routes"
```

---

### Task 7: MCP transport scaffold

**Files:**
- Modify: `package.json` (add `mcp-handler`)
- Create: `app/api/mcp/route.ts`
- Test: `tests/mcp-route.test.ts`

**Interfaces:**
- Produces: the `app/api/mcp/route.ts` module exporting `GET`/`POST`/`DELETE`, and a `withMcpAuth` pattern later tasks extend by adding `server.registerTool(...)` calls inside the same callback.

- [ ] **Step 1: Install the dependency**

Run: `npm install mcp-handler`

Then read `node_modules/mcp-handler/README.md` and confirm `createMcpHandler`'s signature and `server.registerTool`'s exact parameter shape match what's used below — this package moves fast; adjust the code in this and the following two tasks to match what's actually installed before proceeding.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/mcp-route.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: vi.fn(async (request?: Request) => {
    if (request?.headers.get("authorization") === "Bearer valid-token") return { id: "user-1" };
    throw new Error("unauthorized");
  }),
}));

import { POST } from "@/app/api/mcp/route";

describe("MCP route auth", () => {
  it("rejects a request with no bearer token", async () => {
    const request = new Request("http://localhost/api/mcp", { method: "POST", body: "{}" });
    const response = await POST(request as never);
    expect(response.status).toBe(401);
  });

  it("accepts a request with a valid bearer token", async () => {
    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const response = await POST(request as never);
    expect(response.status).not.toBe(401);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/mcp-route.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/mcp/route'`

- [ ] **Step 4: Implement the route**

```typescript
// app/api/mcp/route.ts
import { createMcpHandler } from "mcp-handler";
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";

// Every tool-registration task below (8, 9, 11) adds server.registerTool(...)
// calls inside this same callback, closing over `userId` from the
// authenticated request — there is no session state between requests, so a
// fresh handler is built per call, matching the app's existing per-request
// admin-client pattern.
async function handleMcp(request: NextRequest): Promise<Response> {
  let userId: string;
  try {
    userId = (await requireUser(request)).id;
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handler = createMcpHandler((server) => {
    server.registerTool(
      "whoami",
      { title: "Who am I", description: "Returns the authenticated user id — used to verify the connection is wired correctly." },
      async () => ({ content: [{ type: "text", text: userId }] }),
    );
    // Tasks 8, 9, and 11 register the real tool surface here.
  });

  return handler(request);
}

export { handleMcp as GET, handleMcp as POST, handleMcp as DELETE };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/mcp-route.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json app/api/mcp/route.ts tests/mcp-route.test.ts
git commit -m "feat: scaffold a bearer-authenticated MCP route"
```

---

### Task 8: Register Tier 1 read tools

**Files:**
- Modify: `app/api/mcp/route.ts`

**Interfaces:**
- Consumes: `loadBrandContext` (Task 6), `listBufferConnections`/`getBufferChannelsForConnection` (existing, `lib/settings/buffer.ts`)

- [ ] **Step 1: Register the read tools**

```typescript
// app/api/mcp/route.ts — inside the createMcpHandler callback, after "whoami"
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadBrandContext } from "@/lib/athena/brand-context";
import { listBufferConnections, getBufferChannelsForConnection } from "@/lib/settings/buffer";

server.registerTool(
  "get_brand_profile",
  { title: "Get brand profile", description: "Read the current brand profile (name, voice, audience, proof points, colors/fonts)." },
  async () => ({ content: [{ type: "text", text: JSON.stringify(await loadBrandContext(userId)) }] }),
);

server.registerTool(
  "list_categories",
  { title: "List post types", description: "List every post type (category) the account has defined." },
  async () => {
    const supabase = createAdminSupabase();
    const { data, error } = await supabase.from("categories").select("*").eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { content: [{ type: "text", text: JSON.stringify(data ?? []) }] };
  },
);

server.registerTool(
  "get_category",
  { title: "Get post type", description: "Read one post type by its key.", inputSchema: z.object({ key: z.string() }) },
  async ({ key }) => {
    const supabase = createAdminSupabase();
    const { data, error } = await supabase.from("categories").select("*").eq("key", key).eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`unknown category ${key}`);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.registerTool(
  "list_ideas",
  {
    title: "List ideas",
    description: "List post ideas, optionally filtered by post type or status.",
    inputSchema: z.object({
      categoryKey: z.string().optional(),
      status: z.enum(["pending_review", "approved", "rejected", "generating", "generated", "posted"]).optional(),
    }),
  },
  async ({ categoryKey, status }) => {
    const supabase = createAdminSupabase();
    let query = supabase.from("ideas").select("*").eq("user_id", userId);
    if (categoryKey) query = query.eq("category_key", categoryKey);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return { content: [{ type: "text", text: JSON.stringify(data ?? []) }] };
  },
);

server.registerTool(
  "get_idea",
  { title: "Get idea", description: "Read one idea by id.", inputSchema: z.object({ id: z.string() }) },
  async ({ id }) => {
    const supabase = createAdminSupabase();
    const { data, error } = await supabase.from("ideas").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`unknown idea ${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.registerTool(
  "list_buffer_connections",
  { title: "List Buffer connections", description: "List the account's named Buffer connections (never returns tokens)." },
  async () => ({ content: [{ type: "text", text: JSON.stringify(await listBufferConnections(userId)) }] }),
);

server.registerTool(
  "list_buffer_channels",
  {
    title: "List Buffer channels",
    description: "List the connected social channels available on one Buffer connection.",
    inputSchema: z.object({ connectionId: z.string() }),
  },
  async ({ connectionId }) => ({ content: [{ type: "text", text: JSON.stringify(await getBufferChannelsForConnection(userId, connectionId)) }] }),
);
```

- [ ] **Step 2: Run the test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Manual smoke test**

Start the dev server, mint a token (Task 2), and call `get_brand_profile` and `list_categories` with a plain `curl` POST carrying `Authorization: Bearer <token>` and a `tools/call` JSON-RPC body, to confirm real data comes back (not just unit-test mocks).

- [ ] **Step 4: Commit**

```bash
git add app/api/mcp/route.ts
git commit -m "feat: register Tier 1 read tools on the MCP server"
```

---

### Task 9: Register Tier 1 write tools

**Files:**
- Modify: `app/api/mcp/route.ts`

**Interfaces:**
- Consumes: every `*ForUser` function produced in Tasks 3–6, plus existing userId-parameterized `generateIdeas` (`lib/athena/generate-ideas.ts`)

- [ ] **Step 1: Register the write tools**

Each tool below follows the same shape: a zod `inputSchema`, and a handler that calls the matching `*ForUser(userId, ...)` function and returns its result (or `{ ok: true }` for functions returning `void`).

| Tool name | inputSchema fields | Calls |
|---|---|---|
| `update_brand_profile` | the `BrandProfileFields` shape from Task 3 | `saveBrandProfileForUser` |
| `extract_brand_from_source` | `url?: string, documentUrls?: string[], turns?: {role, text}[]` | `extractBrandProfileForUser` |
| `create_category` | `CategoryFields` shape from `lib/categories.ts` | `createCategoryForUser` |
| `update_category` | `id: string` + `CategoryFields` | `updateCategoryForUser` |
| `clear_role_ref_url` | `categoryId: string, role: enum` | `clearRoleRefUrlForUser` |
| `draft_category_turn` *(deferred — see Task 6 note; add once `draftCategoryTurnForUser` exists)* | `turns, categoryId?, styleRefUrl?` | `draftCategoryTurnForUser` |
| `generate_ideas` | `categoryKey: string, count: 1-20` | `generateIdeas(userId, categoryKey, count)` |
| `set_idea_decision` | `id: string, decision: "approved"\|"rejected"` | `setIdeaDecisionForUser` |
| `create_manual_idea` | `categoryKey, concept, slides, postText?` | `createManualIdeaForUser` |
| `rewrite_caption` | `categoryKey, note, currentText?, imageUrls?, ideaId?` | `rewriteCaptionForUser` |
| `adapt_caption` | `categoryKey, baseText, service, ideaId?` | `adaptCaptionForUser` |

Two worked examples — repeat this exact shape for the rest of the table, substituting the schema and function:

```typescript
server.registerTool(
  "update_brand_profile",
  {
    title: "Update brand profile",
    description: "Overwrite the brand profile fields (name, description, audience, voice, avoid, proof points, standing, colors, fonts, visual notes).",
    inputSchema: z.object({
      business_name: z.string(), business_description: z.string(), audience: z.string(),
      voice: z.string(), avoid: z.string(), proof_points: z.array(z.string()),
      standing: z.array(z.string()), colors: z.array(z.string()), fonts: z.array(z.string()),
      visual_notes: z.string(),
    }),
  },
  async (fields) => {
    await saveBrandProfileForUser(userId, fields);
    return { content: [{ type: "text", text: "brand profile updated" }] };
  },
);

server.registerTool(
  "generate_ideas",
  {
    title: "Generate ideas",
    description: "Generate new AI post ideas for a post type — writes them into the review queue, does not auto-approve.",
    inputSchema: z.object({ categoryKey: z.string(), count: z.number().int().min(1).max(20) }),
  },
  async ({ categoryKey, count }) => ({ content: [{ type: "text", text: JSON.stringify(await generateIdeas(userId, categoryKey, count)) }] }),
);
```

- [ ] **Step 2: Run the test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Manual smoke test**

Call `create_category` then `generate_ideas` then `set_idea_decision` through the same curl-based flow as Task 8, confirming rows land in Supabase.

- [ ] **Step 4: Commit**

```bash
git add app/api/mcp/route.ts
git commit -m "feat: register Tier 1 write tools on the MCP server"
```

---

### Task 10: Confirmation gate and Tier 2 tools

**Files:**
- Create: `lib/mcp/confirm.ts`
- Modify: `app/api/mcp/route.ts`
- Test: `tests/mcp-confirm.test.ts`

**Interfaces:**
- Produces: `assertConfirmed(input: { confirm?: boolean }, summary: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-confirm.test.ts
import { describe, expect, it } from "vitest";
import { assertConfirmed } from "@/lib/mcp/confirm";

describe("assertConfirmed", () => {
  it("throws with the summary when confirm is missing or false", () => {
    expect(() => assertConfirmed({}, "delete category FOO")).toThrow(/delete category FOO/);
    expect(() => assertConfirmed({ confirm: false }, "delete category FOO")).toThrow();
  });
  it("does not throw when confirm is true", () => {
    expect(() => assertConfirmed({ confirm: true }, "delete category FOO")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-confirm.test.ts`
Expected: FAIL — `Cannot find module '@/lib/mcp/confirm'`

- [ ] **Step 3: Implement it**

```typescript
// lib/mcp/confirm.ts
export function assertConfirmed(input: { confirm?: boolean }, summary: string): void {
  if (input.confirm !== true) {
    throw new Error(
      `Not confirmed: this would ${summary}. Show the user exactly what will happen and get their explicit ` +
        `go-ahead, then call this tool again with confirm: true.`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-confirm.test.ts`
Expected: PASS

- [ ] **Step 5: Register the Tier 2 tools**

```typescript
// app/api/mcp/route.ts
import { assertConfirmed } from "@/lib/mcp/confirm";
import { removeBufferConnection } from "@/lib/settings/buffer";
import { submitGenerations } from "@/lib/athena/submit-generations";
import { resubmitSlide } from "@/lib/athena/resubmit-slide";

server.registerTool(
  "delete_category",
  {
    title: "Delete post type",
    description: "Permanently delete a post type. Irreversible — always confirm with the user first. Requires confirm: true.",
    inputSchema: z.object({ id: z.string(), confirm: z.boolean().optional() }),
  },
  async ({ id, confirm }) => {
    assertConfirmed({ confirm }, `permanently delete category ${id}`);
    await deleteCategoryForUser(userId, id);
    return { content: [{ type: "text", text: `deleted category ${id}` }] };
  },
);

server.registerTool(
  "remove_buffer_connection",
  {
    title: "Remove Buffer connection",
    description: "Disconnect a Buffer connection. Irreversible in-app (the external Buffer/social account itself is unaffected). Requires confirm: true.",
    inputSchema: z.object({ connectionId: z.string(), confirm: z.boolean().optional() }),
  },
  async ({ connectionId, confirm }) => {
    assertConfirmed({ confirm }, `remove Buffer connection ${connectionId}`);
    await removeBufferConnection(userId, connectionId);
    return { content: [{ type: "text", text: `removed connection ${connectionId}` }] };
  },
);

server.registerTool(
  "submit_image_generation",
  {
    title: "Generate images",
    description: "Submit ideas for image generation — spends real API credit per image. Requires confirm: true.",
    inputSchema: z.object({ ideaIds: z.array(z.string()).min(1), refinementNotes: z.string().optional(), confirm: z.boolean().optional() }),
  },
  async ({ ideaIds, refinementNotes, confirm }) => {
    assertConfirmed({ confirm }, `submit ${ideaIds.length} idea(s) for image generation (spends API credit)`);
    return { content: [{ type: "text", text: JSON.stringify(await submitGenerations(userId, ideaIds, refinementNotes ?? "")) }] };
  },
);

server.registerTool(
  "resubmit_slide",
  {
    title: "Regenerate one slide",
    description: "Regenerate a single slide of a carousel — spends real API credit. Requires confirm: true.",
    inputSchema: z.object({ ideaId: z.string(), slideIndex: z.number().int().min(1), refinementNotes: z.string().optional(), confirm: z.boolean().optional() }),
  },
  async ({ ideaId, slideIndex, refinementNotes, confirm }) => {
    assertConfirmed({ confirm }, `regenerate slide ${slideIndex} of idea ${ideaId} (spends API credit)`);
    return { content: [{ type: "text", text: JSON.stringify(await resubmitSlide(userId, ideaId, slideIndex, refinementNotes ?? "")) }] };
  },
);

const ScheduleChannelInput = z.object({ connectionId: z.string(), channelId: z.string(), service: z.string(), caption: z.string() });

server.registerTool(
  "schedule_post",
  {
    title: "Schedule a post",
    description:
      "Schedule generated images to post to one or more connected channels at a future time via Buffer. " +
      "This reaches a real, live social account and cannot be un-posted. scheduled_at is REQUIRED and must be " +
      "in the future — there is no 'post now' tool. Requires confirm: true.",
    inputSchema: z.object({
      categoryKey: z.string(),
      generationIds: z.array(z.string()).min(1),
      channels: z.array(ScheduleChannelInput).min(1),
      caption: z.string(),
      scheduledAt: z.string(),
      postGroupId: z.string().optional(),
      confirm: z.boolean().optional(),
    }),
  },
  async ({ categoryKey, generationIds, channels, caption, scheduledAt, postGroupId, confirm }) => {
    assertConfirmed(
      { confirm },
      `schedule a post to ${channels.length} channel(s) for ${scheduledAt} — this will go out to a live connected account`,
    );
    const parsed = new Date(scheduledAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() < Date.now()) {
      throw new Error("scheduledAt must be a valid ISO date string in the future");
    }
    // Reuses the same lookup/validation the HTTP route performs before
    // calling createPostForUser (Task 5) — see app/api/posts/create/route.ts
    // for the category/generation/sibling queries this must run first.
    const result = await scheduleValidatedPost(userId, {
      categoryKey, generationIds, channels, caption, scheduledAt: parsed.toISOString(), postGroupId: postGroupId ?? null,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);
```

- [ ] **Step 6: Extract the shared validation wrapper `scheduleValidatedPost`**

`schedule_post` needs the exact same category/generation/duplicate/anchor validation the route in `app/api/posts/create/route.ts` runs before calling `createPostForUser` — duplicating that validation inline in the MCP route would drift from it over time. Add one more export to `app/api/posts/create/route.ts`:

```typescript
// app/api/posts/create/route.ts
export async function scheduleValidatedPost(
  userId: string,
  input: { categoryKey: string; generationIds: string[]; channels: ChannelInput[]; caption: string; scheduledAt: string; postGroupId: string | null },
): Promise<{ postGroupId: string; results: ChannelResult[] }> {
  const supabase = createAdminSupabase();
  const { data: category, error: catErr } = await supabase
    .from("categories").select("*").eq("key", input.categoryKey).eq("user_id", userId).single();
  if (catErr || !category || !(category as Category).active) throw new Error("unknown or inactive category");

  const { data: gensData, error: genErr } = await supabase
    .from("generations").select("*, idea:ideas(*)").in("id", input.generationIds).eq("user_id", userId);
  if (genErr) throw new Error(genErr.message);
  const gens = (gensData ?? []) as (Generation & { idea: Idea })[];
  if (gens.length !== input.generationIds.length) throw new Error("one or more generations not found");

  const ideaIds = gens.map((g) => g.idea_id);
  const slideKeys = gens.map((g) => `${g.idea_id}:${g.slide_index}`);
  if (new Set(slideKeys).size !== slideKeys.length) throw new Error("duplicate slide in selection");
  for (const g of gens) {
    if (g.status !== "succeeded" || !g.public_url) throw new Error(`generation ${g.id} has no successful image`);
    if (g.idea.status !== "generated" && g.idea.status !== "generating") throw new Error(`idea for generation ${g.id} is not postable (${g.idea.status})`);
    if (g.idea.category_key !== input.categoryKey) throw new Error(`generation ${g.id} belongs to another category`);
  }

  const { data: siblingsData, error: sibErr } = await supabase
    .from("generations").select("id, idea_id, slide_index, anchor_generation_id, status, created_at")
    .in("idea_id", ideaIds).eq("user_id", userId);
  if (sibErr) throw new Error(sibErr.message);
  const siblings = (siblingsData ?? []) as Pick<Generation, "id" | "idea_id" | "slide_index" | "anchor_generation_id" | "status" | "created_at">[];
  const wrongAnchor = findWrongAnchorGenerationIds(gens.map((g) => ({ id: g.id, idea_id: g.idea_id, slide_index: g.slide_index })), siblings);
  if (wrongAnchor.length > 0) throw new Error(`generation ${wrongAnchor[0]} does not belong to its idea's current anchor`);

  const byId = new Map(gens.map((g) => [g.id, g]));
  const ordered = input.generationIds.map((id) => byId.get(id)!);
  const imageUrls = ordered.map((g) => g.public_url);
  const uniqueIdeaIds = Array.from(new Set(ideaIds));
  const singleIdeaId = uniqueIdeaIds.length === 1 ? uniqueIdeaIds[0] : null;
  const postGroupId = input.postGroupId ?? randomUUID();

  const { postGroupId: pg, results } = await createPostForUser(userId, {
    categoryKey: input.categoryKey, postGroupId, channels: input.channels, baseCaption: input.caption,
    scheduledAt: input.scheduledAt, suppliedPostGroupId: input.postGroupId, ordered, imageUrls,
    singleIdeaId, siblings, gens, uniqueIdeaIds,
  });
  return { postGroupId: pg, results };
}
```

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Manual smoke test**

With a real generated carousel in a dev/test account, call `schedule_post` with `scheduledAt` a few minutes in the future and `confirm: true`, then check the account's Buffer queue to confirm the post actually landed as scheduled (not immediately live).

- [ ] **Step 9: Commit**

```bash
git add lib/mcp/confirm.ts app/api/mcp/route.ts app/api/posts/create/route.ts tests/mcp-confirm.test.ts
git commit -m "feat: add confirmation gate and register Tier 2 tools (delete, disconnect, generate, schedule)"
```

---

### Task 11: Claude Code plugin packaging

**Files:**
- Create: `.claude-plugin/plugin.json` (or the location your Claude Code plugin tooling expects — check how the existing `agent-authoring` plugin is packaged and mirror it)
- Create: `docs/mcp-agent-integration.md`

**Interfaces:** none (packaging only)

- [ ] **Step 1: Write the plugin manifest**

Mirror the structure `agent-authoring` uses (an MCP server entry pointing at a URL rather than a local command, since this is a remote server): a `mcpServers` entry naming the deployed `/api/mcp` URL and declaring that the client must send an `Authorization: Bearer <token>` header, where the token is supplied via the plugin's configuration (Claude Code plugins support prompting for a secret value at install time — check the current plugin schema docs for the exact field name for a user-supplied secret header before finalizing this file).

- [ ] **Step 2: Write the setup doc**

`docs/mcp-agent-integration.md` should cover: how to mint a token (Task 2), how to install the plugin pointing at the deployed `/api/mcp` URL, the full tool list with Tier 1/Tier 2 labels, and an explicit callout that `schedule_post` reaches a live social account and must always be confirmed with the human before use.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/ docs/mcp-agent-integration.md
git commit -m "docs: package the MCP server as an installable Claude Code plugin"
```

---

### Task 12: End-to-end verification

**Files:** none — manual verification only

- [ ] **Step 1:** Mint a token via `createApiToken`, install the plugin in a Claude Code session pointed at a local or deployed instance.
- [ ] **Step 2:** Ask Claude Code (through the plugin, not the browser) to: read the brand profile, create a test post type, generate 2 ideas, approve one, and confirm each tool call's output matches what the config/ideas pages show for the same account.
- [ ] **Step 3:** Ask it to submit image generation for the approved idea — confirm it refuses until you explicitly say to proceed, then confirm it actually spends credit and images land.
- [ ] **Step 4:** Ask it to schedule the resulting post to a real (test) Buffer channel a few minutes out — confirm it refuses without confirmation, then confirm the scheduled post appears in Buffer's queue at the right time, not immediately live.
- [ ] **Step 5:** Ask it to delete the test post type — confirm it refuses without confirmation, then confirm the row is actually gone.
- [ ] **Step 6:** Revoke the token (`revokeApiToken`) and confirm a subsequent tool call now returns 401.

No commit — this task is a verification pass, not a code change.
