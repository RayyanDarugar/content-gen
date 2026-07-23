# Multi-Tenant Phase A — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the single-tenant app into a user-scoped multi-tenant foundation: self-serve invite-gated signup, RLS isolation by `user_id`, and every existing data path made user-aware — without yet touching keys, Buffer, or category shape.

**Architecture:** Add `user_id` to every domain table with RLS `auth.uid() = user_id`. Replace the single-`ALLOWED_EMAIL` gate with "any authenticated user is a valid tenant." Service-role code paths (idea/image/post orchestration) explicitly set and filter `user_id`; RLS-enforced paths (config/ideas server actions) get isolation automatically. This is the foundation Phases B–D build on.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres + Auth, `@supabase/ssr`), vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-multi-tenant-beta-design.md` — governs on any conflict.
- Tenancy is **user-scoped**: `user_id uuid not null references auth.users(id) on delete cascade` on every domain table; RLS is exactly `auth.uid() = user_id`. No orgs/memberships tables.
- Signup is gated by an invite code equal to env `INVITE_CODE` (dev value `supercontent2026`). No email allowlist. Email confirmation is disabled at the Supabase project level (not a code concern).
- Service-role clients (`createAdminSupabase`) bypass RLS and MUST explicitly set `user_id` on inserts and filter `.eq("user_id", userId)` on reads/updates of tenant data. RLS is the backstop, not the only guard.
- This phase does NOT change the `categories` column shape (no dropping `buffer_account`, no `output_format`) and does NOT create the `user_settings`/`brand_profiles`/`usage_counters` tables — those belong to Phases B–D.
- Working dir is the worktree `.worktrees/multi-tenant` on branch `multi-tenant`, pointed at the fresh Supabase project `ahxuentgbvfuigiiubpz` (migrations 0001–0004 already applied). Read `node_modules/next/dist/docs/` before writing Next.js code (per AGENTS.md).
- No dedicated unit-test harness exists for DB/orchestration code; those tasks verify via `npm run build` (typecheck) + `npm test` (existing 23-test suite stays green) + the live isolation check in the final task. Only genuinely pure new logic gets a vitest test. Do not write tests that assert nothing.

## File Structure

- `supabase/migrations/0005_multi_tenant_foundation.sql` — user_id columns + RLS rewrite (create)
- `lib/auth/invite.ts` — pure invite-code check (create); `tests/invite.test.ts` (create)
- `lib/auth/require-user.ts` — `requireAllowedUser` → `requireUser` returning the user (modify)
- `middleware.ts` — drop email gate, allow any authed user, add `/signup` public (modify)
- `app/signup/page.tsx`, `app/signup/actions.ts` — signup UI + invite-gated server action (create)
- `app/login/page.tsx` — remove "not allowed" path, add signup link (modify)
- `lib/athena/generate-ideas.ts` + `app/api/ideas/generate/route.ts` — thread `userId` (modify)
- `lib/athena/submit-generations.ts` + `app/api/images/generate/route.ts` — thread `userId` (modify)
- `app/api/posts/create/route.ts` — thread `userId` (modify)
- `app/(app)/config/actions.ts`, `app/(app)/ideas/actions.ts` — swap to `requireUser` (modify)
- `scripts/verify-isolation.ts` — two-user RLS isolation check (create)

**Note:** `scripts/seed-categories.ts` is Athena-legacy (hardcoded `buffer_account`, no `user_id`); it is not run against the beta DB and is left untouched — Phase B replaces category creation with UI.

---

### Task 1: Migration 0005 — user_id columns + RLS rewrite

**Files:**
- Create: `supabase/migrations/0005_multi_tenant_foundation.sql`

**Interfaces:**
- Produces: `user_id` column + `auth.uid() = user_id` RLS on `categories`, `ideas`, `generations`, `posts`, `post_images`. Later tasks rely on `user_id` existing and being NOT NULL.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0005_multi_tenant_foundation.sql
-- Phase A: user-scoped multi-tenancy. Add user_id to every domain table and
-- replace the single-allowed-email RLS policies with per-user isolation.
-- The dev Supabase tables are empty, so NOT NULL needs no backfill.

-- 1. Add user_id to each domain table.
alter table categories   add column user_id uuid not null references auth.users(id) on delete cascade;
alter table ideas        add column user_id uuid not null references auth.users(id) on delete cascade;
alter table generations  add column user_id uuid not null references auth.users(id) on delete cascade;
alter table posts        add column user_id uuid not null references auth.users(id) on delete cascade;
alter table post_images  add column user_id uuid not null references auth.users(id) on delete cascade;

create index categories_user_idx  on categories(user_id);
create index ideas_user_idx       on ideas(user_id);
create index generations_user_idx on generations(user_id);
create index posts_user_idx       on posts(user_id);
create index post_images_user_idx on post_images(user_id);

-- categories.key is no longer globally unique; it is unique per user.
alter table categories drop constraint categories_key_key;
alter table categories add constraint categories_user_key_unique unique (user_id, key);

-- 2. Drop the old single-user policies (from 0001 "auth full access" replaced by
--    0002 "allowed user only") and replace with per-user isolation.
drop policy "allowed user only" on categories;
drop policy "allowed user only" on ideas;
drop policy "allowed user only" on generations;
drop policy "allowed user only" on posts;
drop policy "allowed user only" on post_images;

create policy "owner all" on categories  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner all" on ideas        for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner all" on generations  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner all" on posts        for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner all" on post_images  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

- [ ] **Step 2: USER STEP — apply the migration**

The controller must have Rayyan paste `0005_multi_tenant_foundation.sql` into the new Supabase project's SQL editor and run it before any task that reads/writes tenant data can be live-verified. (Same manual-migration pattern as every prior phase.) Confirm it succeeds with no error.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0005_multi_tenant_foundation.sql
git commit -m "feat: migration 0005 - user_id columns + per-user RLS"
```

---

### Task 2: Invite-code check (pure, TDD)

**Files:**
- Create: `lib/auth/invite.ts`
- Test: `tests/invite.test.ts`

**Interfaces:**
- Produces: `checkInviteCode(input: string): boolean` — constant-time compare of `input` against `process.env.INVITE_CODE`. Task 4's signup action consumes it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/invite.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { checkInviteCode } from "@/lib/auth/invite";

describe("checkInviteCode", () => {
  afterEach(() => { delete process.env.INVITE_CODE; });

  it("returns true for the exact code", () => {
    process.env.INVITE_CODE = "supercontent2026";
    expect(checkInviteCode("supercontent2026")).toBe(true);
  });
  it("returns false for a wrong code", () => {
    process.env.INVITE_CODE = "supercontent2026";
    expect(checkInviteCode("nope")).toBe(false);
    expect(checkInviteCode("supercontent2026 ")).toBe(false);
  });
  it("returns false when INVITE_CODE is unset (fail closed)", () => {
    expect(checkInviteCode("anything")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/invite.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth/invite`.

- [ ] **Step 3: Implement `lib/auth/invite.ts`**

```ts
import { timingSafeEqual } from "crypto";

export function checkInviteCode(input: string): boolean {
  const expected = process.env.INVITE_CODE;
  if (!expected) return false; // fail closed if unconfigured
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/invite.test.ts` → all PASS. Then `npm test` → full suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/invite.ts tests/invite.test.ts
git commit -m "feat: invite-code check"
```

---

### Task 3: Auth helper — requireAllowedUser → requireUser

**Files:**
- Modify: `lib/auth/require-user.ts`

**Interfaces:**
- Produces: `requireUser(): Promise<User>` — returns the authenticated Supabase user, throws `Error("unauthorized")` if none. A temporary `requireAllowedUser()` shim delegates to it so existing call sites keep building; the shim is removed in Task 9. All later tasks consume `requireUser`.

- [ ] **Step 1: Rewrite `lib/auth/require-user.ts` (new function + temporary shim)**

```ts
import "server-only";
import type { User } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase/server";

export async function requireUser(): Promise<User> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

// Temporary shim so existing call sites keep building while they are migrated
// to requireUser across Tasks 6–9. Removed in Task 9.
export async function requireAllowedUser(): Promise<User> {
  return requireUser();
}
```

- [ ] **Step 2: Verify build stays green**

Run: `npm run build`
Expected: SUCCESS — the shim keeps all five existing `requireAllowedUser` call sites valid. (Note: the shim no longer enforces a specific email — that's intentional; the email gate is gone as of this phase.)

- [ ] **Step 3: Commit**

```bash
git add lib/auth/require-user.ts
git commit -m "feat: add requireUser (returns user); keep requireAllowedUser as temporary shim"
```

---

### Task 4: Signup page + invite-gated action

**Files:**
- Create: `app/signup/actions.ts`
- Create: `app/signup/page.tsx`

**Interfaces:**
- Consumes: `checkInviteCode` (Task 2).
- Produces: `/signup` route; server action `signUp(formData)` returning `{ error?: string }`.

- [ ] **Step 1: Implement `app/signup/actions.ts`**

```ts
"use server";
import { createServerSupabase } from "@/lib/supabase/server";
import { checkInviteCode } from "@/lib/auth/invite";

export async function signUp(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const invite = String(formData.get("invite") ?? "");

  if (!checkInviteCode(invite)) return { error: "Invalid invite code." };
  if (!email || password.length < 8) {
    return { error: "Enter an email and a password of at least 8 characters." };
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: error.message };
  return {};
}
```

- [ ] **Step 2: Implement `app/signup/page.tsx`**

```tsx
"use client";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { signUp } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrainIcon } from "@/components/train-icon";

export default function SignupPage() {
  const router = useRouter();
  const [state, action, pending] = useActionState(signUp, undefined);

  // On success (no error returned and the form was submitted), sign the user in
  // client-side so the session cookie is set, then land them in the app.
  useEffect(() => {
    if (state && !state.error) {
      router.push("/ideas");
      router.refresh();
    }
  }, [state, router]);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrainIcon className="h-6 w-6 text-primary" />
            Create your account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
            <Input name="email" type="email" placeholder="you@example.com" required />
            <Input name="password" type="password" placeholder="Password (8+ chars)" required />
            <Input name="invite" type="text" placeholder="Invite code" required />
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Creating…" : "Sign up"}
            </Button>
            {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          </form>
          <p className="mt-3 text-sm text-muted-foreground">
            Already have an account? <Link href="/login" className="underline">Sign in</Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
```

Note: with email confirmation disabled, `supabase.auth.signUp` on the server sets the session via cookies (the server client writes cookies through middleware refresh), so the subsequent `/ideas` navigation is authenticated. Verify this in Task 10's manual flow; if the server signUp does not establish the cookie session in this Next version, fall back to a client-side `signInWithPassword` in the success effect (same credentials).

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: SUCCESS (the Task 3 shim keeps everything green).

- [ ] **Step 4: Commit**

```bash
git add app/signup
git commit -m "feat: invite-gated signup page and action"
```

---

### Task 5: Middleware + login page — drop the email gate

**Files:**
- Modify: `middleware.ts`
- Modify: `app/login/page.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: any authenticated user may access protected routes; `/signup` is public.

- [ ] **Step 1: Rewrite the auth logic in `middleware.ts`**

Replace the two post-`getUser()` blocks (the `!user` redirect and the `user.email !== ALLOWED_EMAIL` signout) with:

```ts
  const { data: { user } } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/auth");

  if (!user && !isPublic) {
    const redirectResponse = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.getAll().forEach((c) => redirectResponse.cookies.set(c));
    return redirectResponse;
  }
  return response;
```

(The `ALLOWED_EMAIL` comparison block is deleted entirely.)

- [ ] **Step 2: Remove the "not allowed" message in `app/login/page.tsx`**

Delete the block:

```tsx
          {params.get("error") === "unauthorized" && (
            <p className="text-sm text-destructive">That email is not allowed.</p>
          )}
```

And add a signup link after the form's error `<p>`, inside `CardContent`:

```tsx
          <p className="mt-3 text-sm text-muted-foreground">
            No account? <Link href="/signup" className="underline">Sign up</Link>
          </p>
```

Add `import Link from "next/link";` at the top. (`useSearchParams`/`params` may now be unused — remove them and the `Suspense` wrapper only if the build flags them; otherwise leave as-is.)

- [ ] **Step 3: Verify build** (`npm run build` → SUCCESS).

- [ ] **Step 4: Commit**

```bash
git add middleware.ts app/login/page.tsx
git commit -m "feat: allow any authenticated user; add signup links"
```

---

### Task 6: Thread user_id through idea generation

**Files:**
- Modify: `lib/athena/generate-ideas.ts`
- Modify: `app/api/ideas/generate/route.ts`

**Interfaces:**
- Consumes: `requireUser` (Task 3).
- Produces: `generateIdeas(userId: string, categoryKey: string, count: number)` — scopes the categories query by `user_id` and stamps `user_id` on inserted ideas.

- [ ] **Step 1: Update `lib/athena/generate-ideas.ts`**

Change the signature and the two data touchpoints:

```ts
export async function generateIdeas(userId: string, categoryKey: string, count: number) {
  const supabase = createAdminSupabase();
  const anthropic = new Anthropic();

  let query = supabase.from("categories").select("*").eq("user_id", userId).eq("active", true);
  if (categoryKey !== "ALL") query = query.eq("key", categoryKey);
```

And stamp `user_id` on the insert:

```ts
    const { error: insErr } = await supabase.from("ideas").insert(
      kept.map((i) => ({
        user_id: userId,
        category_key: i.category,
        concept: i.concept,
        resolved_prompt: i.concept,
        ai_filter_reason: i.ai_filter_reason,
        approved: false,
        status: "pending_review",
        batch_id: batchId,
      })),
    );
```

- [ ] **Step 2: Update `app/api/ideas/generate/route.ts`**

```ts
import { requireUser } from "@/lib/auth/require-user";
// ...
export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // ...validation unchanged...
  try {
    const result = await generateIdeas(user.id, categoryKey, count);
    return NextResponse.json(result);
  } catch (e) { /* unchanged */ }
}
```

- [ ] **Step 3: Verify build** (`npm run build` → SUCCESS).

- [ ] **Step 4: Commit**

```bash
git add lib/athena/generate-ideas.ts app/api/ideas/generate/route.ts
git commit -m "feat: scope idea generation to the acting user"
```

---

### Task 7: Thread user_id through image submission

**Files:**
- Modify: `lib/athena/submit-generations.ts`
- Modify: `app/api/images/generate/route.ts`

**Interfaces:**
- Consumes: `requireUser` (Task 3).
- Produces: `submitGenerations(userId: string, ideaIds: string[], refinementNotes?: string)` — scopes the ideas and categories queries by `user_id` and stamps `user_id` on inserted generations.

- [ ] **Step 1: Update `lib/athena/submit-generations.ts`**

Change signature and scope both queries + stamp both inserts:

```ts
export async function submitGenerations(
  userId: string,
  ideaIds: string[],
  refinementNotes = "",
): Promise<SubmitResult> {
  const supabase = createAdminSupabase();

  const { data: ideasData, error: ideasErr } = await supabase
    .from("ideas").select("*").eq("user_id", userId).in("id", ideaIds);
```

Categories query:

```ts
  const { data: catsData, error: catsErr } = await supabase
    .from("categories").select("*").eq("user_id", userId)
    .in("key", [...new Set(eligible.map((i) => i.category_key))]);
```

Success-path generation insert — add `user_id: userId`:

```ts
      const { error: insErr } = await supabase.from("generations").insert({
        user_id: userId,
        idea_id: idea.id,
        kie_task_id: taskId,
        status: "submitted",
        kie_style_url: styleUrl,
        full_prompt: fullPrompt,
        refinement_notes: refinementNotes,
      });
```

Failure-path generation insert — add `user_id: userId`:

```ts
      await supabase.from("generations").insert({
        user_id: userId,
        idea_id: idea.id, status: "failed", error: message,
        refinement_notes: refinementNotes,
      });
```

- [ ] **Step 2: Update `app/api/images/generate/route.ts`**

Swap the auth call to capture the user and pass the id:

```ts
import { requireUser } from "@/lib/auth/require-user";
// ...
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // ...validation unchanged...
    const result = await submitGenerations(user.id, ideaIds as string[], refinementNotes);
```

- [ ] **Step 3: Verify build** (`npm run build`) — these two files now typecheck.

- [ ] **Step 4: Commit**

```bash
git add lib/athena/submit-generations.ts app/api/images/generate/route.ts
git commit -m "feat: scope image submission to the acting user"
```

---

### Task 8: Thread user_id through posting

**Files:**
- Modify: `app/api/posts/create/route.ts`

**Interfaces:**
- Consumes: `requireUser` (Task 3).
- Produces: posting scoped to the acting user (queries filtered by `user_id`; `posts` and `post_images` inserts stamped with `user_id`).

- [ ] **Step 1: Capture the user and scope every query/insert**

Swap the auth block to capture the user:

```ts
import { requireUser } from "@/lib/auth/require-user";
// ...
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
```

Scope the category lookup: `.eq("key", categoryKey)` → add `.eq("user_id", user.id)` before `.single()`.
Scope the generations lookup: `.in("id", generationIds as string[])` → add `.eq("user_id", user.id)`.
Scope the sibling-generations lookup: `.in("idea_id", ideaIds)` → add `.eq("user_id", user.id)`.
Stamp the failed-path `posts` insert, the success `posts` insert, and each `post_images` row with `user_id: user.id`. For example the success insert:

```ts
  const { data: postRow, error: postErr } = await supabase
    .from("posts")
    .insert({
      user_id: user.id,
      category_key: categoryKey,
      buffer_update_id: result.postId,
      caption,
      status: "queued",
    })
    .select()
    .single();
```

And the `post_images` rows:

```ts
  const { error: imagesErr } = await supabase.from("post_images").insert(
    ordered.map((g, idx) => ({ user_id: user.id, post_id: postRow.id, generation_id: g.id, sort_order: idx })),
  );
```

And the failed-path insert gains `user_id: user.id` alongside `category_key`.

- [ ] **Step 2: Verify build** (`npm run build`).

- [ ] **Step 3: Commit**

```bash
git add app/api/posts/create/route.ts
git commit -m "feat: scope posting to the acting user"
```

---

### Task 9: Swap requireUser in config/ideas actions + remove the shim

**Files:**
- Modify: `app/(app)/config/actions.ts`
- Modify: `app/(app)/ideas/actions.ts`
- Modify: `lib/auth/require-user.ts` (delete the temporary shim)

**Interfaces:**
- Consumes: `requireUser` (Task 3). These actions use `createServerSupabase` (RLS-enforced), so isolation is automatic once the user is authenticated — only the import/call name changes.

- [ ] **Step 1: Update both action files**

In each, change:

```ts
import { requireAllowedUser } from "@/lib/auth/require-user";
// ...
  await requireAllowedUser();
```

to:

```ts
import { requireUser } from "@/lib/auth/require-user";
// ...
  await requireUser();
```

(No other logic changes. `updateCategory` keeps its current `buffer_account` validation for now — the category-shape change is Phase B/C. RLS scopes both actions to the caller's rows.)

- [ ] **Step 2: Remove the temporary shim from `lib/auth/require-user.ts`**

Delete the `requireAllowedUser` shim function added in Task 3, leaving only `requireUser`.

- [ ] **Step 3: Verify the build is fully green with no shim**

Run: `npm run build`
Expected: SUCCESS — confirm zero remaining `requireAllowedUser` references (`grep -rn requireAllowedUser app lib` returns nothing).

Run: `npm test`
Expected: existing suite + `tests/invite.test.ts` all pass.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/config/actions.ts" "app/(app)/ideas/actions.ts" lib/auth/require-user.ts
git commit -m "refactor: use requireUser in config/ideas actions; drop shim"
```

---

### Task 10: Isolation verification (two users, cross-read blocked)

**Files:**
- Create: `scripts/verify-isolation.ts`
- Modify: `package.json` (add a `verify-isolation` script, matching the existing `seed`/`create-admin` convention)

**Interfaces:**
- Consumes: the applied migration 0005; the running signup flow.

- [ ] **Step 1: Write the isolation-check script**

```ts
// scripts/verify-isolation.ts
// Verifies RLS: two users each see only their own categories.
// Run against the dev Supabase after migration 0005 is applied.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function makeUser(email: string) {
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.createUser({
    email, password: "test-password-123", email_confirm: true,
  });
  if (error && !error.message.includes("already been registered")) throw error;
  // fetch id if it already existed
  const id = data?.user?.id ?? (await admin.auth.admin.listUsers()).data.users
    .find((u) => u.email === email)!.id;
  // seed one category for this user via service role
  await admin.from("categories").insert({
    user_id: id, key: `k_${id.slice(0, 8)}`, name: "test",
  });
  return { id, email };
}

async function sessionClient(email: string) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: "test-password-123" });
  if (error) throw error;
  return c;
}

async function main() {
  const a = await makeUser("iso-a@example.com");
  const b = await makeUser("iso-b@example.com");
  const ca = await sessionClient(a.email);
  const cb = await sessionClient(b.email);
  const { data: aRows } = await ca.from("categories").select("user_id");
  const { data: bRows } = await cb.from("categories").select("user_id");
  const aOnlyOwn = (aRows ?? []).every((r) => r.user_id === a.id);
  const bOnlyOwn = (bRows ?? []).every((r) => r.user_id === b.id);
  console.log("A sees", aRows?.length, "rows, all own:", aOnlyOwn);
  console.log("B sees", bRows?.length, "rows, all own:", bOnlyOwn);
  if (!aOnlyOwn || !bOnlyOwn || !aRows?.length || !bRows?.length) {
    throw new Error("ISOLATION FAILED — a user can see another user's rows");
  }
  console.log("ISOLATION OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script + run it (requires migration 0005 applied)**

Add to `package.json` `scripts`: `"verify-isolation": "tsx scripts/verify-isolation.ts"`.

Run: `npm run verify-isolation`
Expected: prints `ISOLATION OK`. If it throws ISOLATION FAILED, the RLS policies from Task 1 are wrong — stop and fix before proceeding.

- [ ] **Step 3: Manual signup smoke test**

Run `npm run dev`, open `/signup`, create an account with the invite code, confirm you land in the app authenticated; open `/signup` again with a wrong code and confirm rejection. Confirm the old single-email login rejection is gone.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-isolation.ts package.json
git commit -m "test: two-user RLS isolation verification script"
```

---

## Phase A completion

After Task 10 is green: the app has invite-gated self-serve signup, per-user RLS isolation verified with two real users, and every existing data path stamps/filters `user_id`. The generation pipeline still reads API keys from env (Phase B rewires that to per-user BYOK) — that's expected; Phase A's deliverable is the tenancy + auth foundation, not the full per-user pipeline. Proceed to writing the Phase B plan against this tested foundation.
