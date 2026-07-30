# MCP Style Reference Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MCP agent trigger the same brand-reference-image generation the browser already has, without blocking the MCP route past its 120-second budget.

**Architecture:** A new `style_ref_jobs` table tracks one row per submitted Kie task. `generate_style_ref` (a new Tier 2 MCP tool) submits the Kie task and returns immediately; the existing cron poller (`app/api/jobs/poll/route.ts`) gains a new polling function that finishes the job later — re-hosting the result on Cloudinary and writing both `categories.style_ref_url` and the job row — exactly mirroring how that same route already finishes `generations` rows. `get_style_ref_job` (a second new tool) lets the agent check status.

**Tech Stack:** Next.js (App Router, route handlers), Supabase (Postgres via `createAdminSupabase`), `mcp-handler` + Zod (existing MCP tool registration pattern), Kie.ai's task-based image API, Cloudinary, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-mcp-style-ref-design.md`

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing Next.js code.** This is not the Next.js in your training data. See `AGENTS.md`.
- **The MCP server has no cookie-based session.** Every function it calls into (`lib/category-mutations.ts`, `lib/brand-profile.ts`, `lib/idea-mutations.ts`, and this plan's new `lib/style-ref-jobs.ts`) uses `createAdminSupabase()` with an **explicit `.eq("user_id", userId)` filter on every query** — there is no RLS-scoped client to lean on automatically. A query missing that filter is a cross-tenant data leak or a cross-tenant write, not a style issue.
- **`generate_style_ref` is a Tier 2 tool** (spends real Kie credit) — it MUST call `assertConfirmed({confirm}, ...)` before any database write or Kie call, matching every other Tier 2 tool in `app/api/mcp/route.ts` (`delete_category`, `submit_image_generation`, `resubmit_slide`, `schedule_post`). It must also be added to `tests/mcp-tier2-gate.test.ts`'s `TIER_2_CALLS` array, which drives the real route and asserts the underlying mutation function is never reached without `confirm: true`.
- **`generate_style_ref` never blocks past the initial Kie submission call.** It must not poll, must not wait on Kie, must return as soon as the job row is inserted. The 5-minute synchronous polling in `lib/style-ref-client.ts` (`generateStyleRef`/`persistStyleRef`) is the browser's own path and must not be reused or imported here.
- **The cron poller integration is a new function inside the existing `app/api/jobs/poll/route.ts`, called from the existing exported `GET`** — not a new route, not a new external cron trigger. That file's `authorized(request)` CRON_SECRET check already gates the whole handler; nothing new is needed there.
- **A poll-count cap is required**, mirroring `generations.poll_count` and `lib/athena/poll-logic.ts`'s `decidePoll`/`POLL_CAP` — without it, a Kie task that never resolves leaves its job row `"polling"` forever, invisible and unbounded. Reuse `decidePoll` directly; do not hand-roll new "success"/"fail" string matching.
- **No live-Kie/live-Supabase tests.** `lib/style-ref-jobs.ts` and the new cron polling function get no automated test, consistent with `lib/category-mutations.ts` and `lib/idea-mutations.ts` (which also make live DB/Kie calls and have none). Run the suite with `npm test`.
- **BYOK:** the Kie key for a submission is resolved with `requireKieKey(userId)` (throws if missing — this is a synchronous, user-initiated call the agent is waiting on, unlike the cron poller's `getKieKeyOrNull`, which must never throw mid-tick over one tenant's missing key).

---

### Task 1: `style_ref_jobs` table and types

**Files:**
- Create: `supabase/migrations/0019_style_ref_jobs.sql`
- Modify: `lib/types.ts`

**Interfaces:**
- Consumes: nothing — this is the foundation task.
- Produces: table `style_ref_jobs` (columns: `id`, `user_id`, `category_id`, `kie_task_id`, `status`, `poll_count`, `style_ref_url`, `error`, `created_at`, `updated_at`); TypeScript types `StyleRefJobStatus` and `StyleRefJob` in `lib/types.ts`.

**Context you need:** The highest existing migration is `0018_api_tokens.sql`, so this is `0019`. This migration has **not** been applied to any live Supabase instance yet — there is nothing to preserve if you need to re-run it during development.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0019_style_ref_jobs.sql`:

```sql
-- supabase/migrations/0019_style_ref_jobs.sql
-- Fire-and-forget job tracking for MCP-triggered style-reference generation
-- (spec docs/superpowers/specs/2026-07-30-mcp-style-ref-design.md). The MCP
-- server has maxDuration = 120 and no session state between requests, so it
-- cannot reuse the browser's own generateStyleRef/persistStyleRef path,
-- which polls Kie to completion synchronously for up to 5 minutes. This
-- table lets an MCP tool submit a Kie task and return immediately; the
-- existing cron poller (app/api/jobs/poll/route.ts) finishes it later,
-- exactly like it already does for `generations`.

create table style_ref_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  kie_task_id text not null,
  status text not null default 'submitted' check (status in ('submitted', 'polling', 'succeeded', 'failed')),
  -- Mirrors generations.poll_count / lib/athena/poll-logic.ts's decidePoll:
  -- without a poll-count cap, a Kie task that never resolves would leave
  -- this row "polling" forever, silently, with no way for an MCP agent to
  -- know to stop waiting.
  poll_count int not null default 0,
  style_ref_url text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index style_ref_jobs_user_idx on style_ref_jobs(user_id);
create index style_ref_jobs_pending_idx on style_ref_jobs(status) where status in ('submitted', 'polling');

alter table style_ref_jobs enable row level security;
create policy "owner all" on style_ref_jobs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

- [ ] **Step 2: Add the types**

In `lib/types.ts`, add (a good location is near `Generation`, since this is its closest sibling concept):

```ts
export type StyleRefJobStatus = "submitted" | "polling" | "succeeded" | "failed";

export interface StyleRefJob {
  id: string;
  user_id: string;
  category_id: string;
  kie_task_id: string;
  status: StyleRefJobStatus;
  poll_count: number;
  style_ref_url: string;
  error: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0019_style_ref_jobs.sql lib/types.ts
git commit -m "feat: style_ref_jobs schema and types"
```

> **Hand-off to Rayyan:** migration 0019 must be applied to Supabase by hand before Task 2's functions or Task 4's tools can work end-to-end (they can still be built and typechecked without it).

---

### Task 2: `lib/style-ref-jobs.ts` — submit and read functions

**Files:**
- Create: `lib/style-ref-jobs.ts`

**Interfaces:**
- Consumes: `loadBrandContext` from `@/lib/athena/brand-context` (existing); `buildStyleRefPrompt` from `@/lib/athena/style-ref-prompt` (existing); `createTextToImageKieTask` from `@/lib/athena/kie` (existing); `requireKieKey` from `@/lib/settings/user-secrets` (existing); `createAdminSupabase` from `@/lib/supabase/admin` (existing); `Category`, `StyleRefJob` from `@/lib/types` (Task 1).
- Produces: `submitStyleRefJobForUser(userId: string, categoryId: string, notes?: string): Promise<{ jobId: string }>` and `getStyleRefJobForUser(userId: string, jobId: string): Promise<{ status: string; error: string; styleRefUrl: string }>`.

**Context you need:** This file follows the exact convention documented at the top of `lib/category-mutations.ts` — `*ForUser` functions take an already-authenticated `userId` and do **not** authenticate themselves; they live outside any `"use server"` module so they are never a directly-callable public endpoint. The MCP route (`app/api/mcp/route.ts`) is their only caller for now. `loadBrandContext(userId)` already does the exact `BrandContext` field-by-field construction this needs — do not re-implement it. `buildStyleRefPrompt` and `createTextToImageKieTask` are unchanged from the earlier style-ref feature; read their existing signatures in `lib/athena/style-ref-prompt.ts` and `lib/athena/kie.ts` if you need to confirm parameter order, but do not modify either file.

- [ ] **Step 1: Write the module**

Create `lib/style-ref-jobs.ts`:

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadBrandContext } from "@/lib/athena/brand-context";
import { buildStyleRefPrompt } from "@/lib/athena/style-ref-prompt";
import { createTextToImageKieTask } from "@/lib/athena/kie";
import { requireKieKey } from "@/lib/settings/user-secrets";
import type { Category, StyleRefJob } from "@/lib/types";

// *ForUser: caller must already have authenticated userId (the MCP route's
// bearer-token auth) — same pattern as lib/category-mutations.ts. Not a
// "use server" module for the same reason documented there: every export of
// one is a public, directly callable endpoint, which would turn an
// unauthenticated submitStyleRefJobForUser(otherTenantId, categoryId) into
// exactly that.

// Submits a Kie text-to-image task and returns immediately — never polls,
// never waits on Kie. The job row is what lets the cron poller
// (app/api/jobs/poll/route.ts) finish this later.
export async function submitStyleRefJobForUser(
  userId: string,
  categoryId: string,
  notes?: string,
): Promise<{ jobId: string }> {
  const supabase = createAdminSupabase();
  // Filtered by BOTH id and user_id — never id alone. This is the only
  // thing standing between an authenticated MCP caller and generating (and,
  // once the job succeeds, persisting) an image against another tenant's
  // category.
  const { data: categoryRow, error: categoryErr } = await supabase
    .from("categories").select("*").eq("id", categoryId).eq("user_id", userId).maybeSingle();
  if (categoryErr) throw new Error(categoryErr.message);
  if (!categoryRow) throw new Error(`unknown category ${categoryId}`);
  const category = categoryRow as Category;

  const brand = await loadBrandContext(userId);
  const kieKey = await requireKieKey(userId);
  const prompt = buildStyleRefPrompt(brand, notes);
  const kieTaskId = await createTextToImageKieTask(kieKey, prompt, category.aspect_ratio);

  const { data: jobRow, error: insertErr } = await supabase
    .from("style_ref_jobs")
    .insert({ user_id: userId, category_id: categoryId, kie_task_id: kieTaskId })
    .select("id")
    .single();
  if (insertErr) throw new Error(insertErr.message);

  return { jobId: jobRow.id as string };
}

export async function getStyleRefJobForUser(
  userId: string,
  jobId: string,
): Promise<{ status: string; error: string; styleRefUrl: string }> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("style_ref_jobs").select("*").eq("id", jobId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`unknown style ref job ${jobId}`);
  const job = data as StyleRefJob;
  return { status: job.status, error: job.error, styleRefUrl: job.style_ref_url };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all existing tests pass (this task adds no test file — it makes live Kie/Supabase calls, consistent with `lib/category-mutations.ts` and `lib/idea-mutations.ts`, which also do and have none).

- [ ] **Step 4: Commit**

```bash
git add lib/style-ref-jobs.ts
git commit -m "feat: submit and read functions for MCP-triggered style ref jobs"
```

---

### Task 3: Cron poller integration

**Files:**
- Modify: `app/api/jobs/poll/route.ts`

**Interfaces:**
- Consumes: `getKieRecord`, `KieRecord` from `@/lib/athena/kie` (existing, already imported in this file); `decidePoll`, `PollDecision` from `@/lib/athena/poll-logic` (existing, already imported); `uploadImageToCloudinary` from `@/lib/cloudinary` (existing, already imported); `getKieKeyOrNull` from `@/lib/settings/user-secrets` (existing, already imported); `StyleRefJob` from `@/lib/types` (Task 1).
- Produces: `pollStyleRefJobs(supabase: SupabaseClient): Promise<{ polled: number; succeeded: number; failed: number }>`, called from the existing exported `GET` handler in this same file. The `GET` response JSON gains three new fields: `styleRefPolled`, `styleRefSucceeded`, `styleRefFailed`.

**Context you need:** Read this file in full before editing — it already imports everything this task needs (`getKieRecord`, `decidePoll`, `uploadImageToCloudinary`, `getKieKeyOrNull`, `createAdminSupabase`), so no new imports beyond the `StyleRefJob` type. The existing `GET` handler already does `const supabase = createAdminSupabase();` near its top — reuse that same client, don't create a second one. The existing per-generation loop caches Kie keys per user in a `Map` within one tick (`kieKeyFor`) — mirror that same caching approach for style-ref jobs rather than re-fetching a key for every row.

**Do not re-encode the downloaded image with `sharp`** the way `ingestImage` does for carousel slides — that recompression exists for a different reason (consistency across many slides in a carousel) and the style-ref feature's own browser-side `finalize` phase (`app/api/categories/draft/style-ref/route.ts`) doesn't do it either. Match that route's validation instead: content-type must start with `image/`, and the buffer must not exceed 15MB (checked both via the `content-length` header as a fast path and the actual downloaded buffer size, exactly as that route already does).

- [ ] **Step 1: Add the polling function**

In `app/api/jobs/poll/route.ts`, add this near the top of the file, after the existing constants (`INGEST_CAP`, `SWEEP_IDEA_CAP`, `FAN_OUT_SWEEP_CAP`):

```ts
// Single-image, no fan-out — a much smaller cap than INGEST_CAP is fine.
const STYLE_REF_POLL_CAP = 10;
const STYLE_REF_MAX_BYTES = 15 * 1024 * 1024;
```

Then add this function, placed after `sweepOrphanedAnchors` and before the exported `GET`:

```ts
// Fire-and-forget completion for generate_style_ref (MCP tool). Mirrors the
// main generations-polling loop above: same decidePoll/getKieRecord contract,
// same per-user Kie-key caching, same per-row try/catch so one bad row can't
// stop the rest. Unlike ingestImage, there is no fan-out and no sharp
// recompression — this validates and re-hosts exactly the way the browser's
// own style-ref finalize phase already does (app/api/categories/draft/style-ref/route.ts).
async function pollStyleRefJobs(
  supabase: SupabaseClient,
): Promise<{ polled: number; succeeded: number; failed: number }> {
  const { data, error } = await supabase
    .from("style_ref_jobs")
    .select("*")
    .in("status", ["submitted", "polling"])
    .order("created_at", { ascending: true })
    .limit(STYLE_REF_POLL_CAP);
  if (error) {
    console.error("style ref job query failed:", error.message);
    return { polled: 0, succeeded: 0, failed: 0 };
  }
  const pending = (data ?? []) as StyleRefJob[];

  let polled = 0;
  let succeeded = 0;
  let failed = 0;

  const keyCache = new Map<string, string | null>();
  async function kieKeyFor(uid: string): Promise<string | null> {
    if (!keyCache.has(uid)) keyCache.set(uid, await getKieKeyOrNull(uid));
    return keyCache.get(uid) ?? null;
  }

  for (const job of pending) {
    try {
      const apiKey = await kieKeyFor(job.user_id);
      if (!apiKey) continue; // owner removed their key; leave the row for a later tick
      polled++;
      const record = await getKieRecord(apiKey, job.kie_task_id);
      const decision = decidePoll(record, job.poll_count);

      if (decision.action === "wait") {
        await supabase
          .from("style_ref_jobs")
          .update({ status: "polling", poll_count: decision.pollCount })
          .eq("id", job.id);
        continue;
      }
      if (decision.action === "fail") {
        failed++;
        await supabase
          .from("style_ref_jobs")
          .update({ status: "failed", error: decision.error })
          .eq("id", job.id);
        continue;
      }

      // decision.action === "ingest"
      const res = await fetch(decision.resultUrl);
      if (!res.ok) throw new Error(`style ref image download failed (HTTP ${res.status})`);
      const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!contentType.startsWith("image/")) {
        throw new Error(`expected an image response, got ${contentType || "unknown content-type"}`);
      }
      const contentLength = res.headers.get("content-length");
      if (contentLength && Number(contentLength) > STYLE_REF_MAX_BYTES) {
        throw new Error("style ref image exceeds 15MB limit");
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > STYLE_REF_MAX_BYTES) throw new Error("style ref image exceeds 15MB limit");

      const { url } = await uploadImageToCloudinary(buffer, contentType);

      const { error: catErr } = await supabase
        .from("categories").update({ style_ref_url: url }).eq("id", job.category_id);
      if (catErr) throw new Error(`category update failed: ${catErr.message}`);

      const { error: jobErr } = await supabase
        .from("style_ref_jobs").update({ status: "succeeded", style_ref_url: url }).eq("id", job.id);
      if (jobErr) throw new Error(`style ref job update failed: ${jobErr.message}`);

      succeeded++;
    } catch (e) {
      // Transient per-row error (network, storage blip): log and let the next
      // tick retry — recordInfo is read-only so nothing is lost, and the row
      // stays "submitted"/"polling" until decidePoll's own poll cap gives up.
      console.error(`style ref poll error for job ${job.id}:`, e);
    }
  }

  return { polled, succeeded, failed };
}
```

- [ ] **Step 2: Wire it into the exported `GET` handler**

In the existing `GET` function, add a call to `pollStyleRefJobs` alongside the existing `sweepOrphanedAnchors` call, and fold its counts into the response. Change:

```ts
  let sweptFanOuts = 0;
  try {
    sweptFanOuts = await sweepOrphanedAnchors(supabase);
  } catch (e) {
    // Same rationale as the per-row catch above: log and let the next tick
    // retry rather than fail the whole response over a sweep-only error.
    console.error("fan-out sweep failed:", e);
  }

  return NextResponse.json({ polled, ingested, failed, pending: pending.length, sweptFanOuts });
```

to:

```ts
  let sweptFanOuts = 0;
  try {
    sweptFanOuts = await sweepOrphanedAnchors(supabase);
  } catch (e) {
    // Same rationale as the per-row catch above: log and let the next tick
    // retry rather than fail the whole response over a sweep-only error.
    console.error("fan-out sweep failed:", e);
  }

  let styleRefPolled = 0;
  let styleRefSucceeded = 0;
  let styleRefFailed = 0;
  try {
    const result = await pollStyleRefJobs(supabase);
    styleRefPolled = result.polled;
    styleRefSucceeded = result.succeeded;
    styleRefFailed = result.failed;
  } catch (e) {
    console.error("style ref job poll failed:", e);
  }

  return NextResponse.json({
    polled, ingested, failed, pending: pending.length, sweptFanOuts,
    styleRefPolled, styleRefSucceeded, styleRefFailed,
  });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all existing tests pass (this task adds no test file — it makes live Kie/Cloudinary/Supabase calls, consistent with the rest of this route, which also has none).

- [ ] **Step 5: Commit**

```bash
git add app/api/jobs/poll/route.ts
git commit -m "feat: poll and finalize style-ref jobs from the existing cron route"
```

---

### Task 4: MCP tools — `generate_style_ref` and `get_style_ref_job`

**Files:**
- Modify: `app/api/mcp/route.ts`
- Modify: `tests/mcp-tier2-gate.test.ts`

**Interfaces:**
- Consumes: `submitStyleRefJobForUser`, `getStyleRefJobForUser` from `@/lib/style-ref-jobs` (Task 2); `assertConfirmed` from `@/lib/mcp/confirm` (existing, already imported in this file).
- Produces: two new registered MCP tools, `generate_style_ref` and `get_style_ref_job`.

**Context you need:** Read `app/api/mcp/route.ts` in full before editing — in particular the existing `submit_image_generation` and `resubmit_slide` registrations (both Tier 2, both under the `// --- Tier 2` comment block), which are the closest precedent for a credit-spending, `assertConfirmed`-gated tool. `generate_style_ref` is Tier 2; `get_style_ref_job` is a plain read tool (no `confirm` needed), matching `get_category`/`get_idea`.

Read `tests/mcp-tier2-gate.test.ts` in full before editing it — it drives the **real** route (not a mock of the tool logic itself) via a constructed `Request`, and asserts that every Tier 2 tool's underlying mutation function is never reached without `confirm: true`. Adding `generate_style_ref` to its `TIER_2_CALLS` array is what proves this new tool actually calls `assertConfirmed` before doing anything — a tool that forgot it would fail this test.

- [ ] **Step 1: Add the import**

In `app/api/mcp/route.ts`, add to the existing import block:

```ts
import { submitStyleRefJobForUser, getStyleRefJobForUser } from "@/lib/style-ref-jobs";
```

- [ ] **Step 2: Register `generate_style_ref`**

Add this registration in the Tier 2 section, immediately after the existing `resubmit_slide` registration (before the `schedule_post` block):

```ts
    server.registerTool(
      "generate_style_ref",
      {
        title: "Generate brand reference image",
        description:
          "Generate a new AI brand style reference image for a post type, grounded in the brand's colors/fonts/visual notes, optionally steered by notes. Fire-and-forget: spends real API credit and completes asynchronously — poll get_style_ref_job with the returned jobId to see when it's done. Requires confirm: true.",
        inputSchema: z.object({
          categoryId: z.string(),
          notes: z.string().optional(),
          confirm: z.boolean().optional(),
        }),
      },
      async ({ categoryId, notes, confirm }) => {
        assertConfirmed(
          { confirm },
          `generate a new brand reference image for category ${categoryId} (spends API credit)`,
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify(await submitStyleRefJobForUser(userId, categoryId, notes)),
          }],
        };
      },
    );
```

- [ ] **Step 3: Register `get_style_ref_job`**

Add this registration immediately after `generate_style_ref`:

```ts
    server.registerTool(
      "get_style_ref_job",
      {
        title: "Get style reference job status",
        description: "Check the status of a style reference image generation previously submitted with generate_style_ref.",
        inputSchema: z.object({ jobId: z.string() }),
      },
      async ({ jobId }) => ({
        content: [{ type: "text", text: JSON.stringify(await getStyleRefJobForUser(userId, jobId)) }],
      }),
    );
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Add `generate_style_ref` to the Tier 2 confirmation gate test**

In `tests/mcp-tier2-gate.test.ts`, add a new spy to the existing `spies` object (inside the `vi.hoisted(() => ({ ... }))` call):

```ts
  submitStyleRefJobForUser: vi.fn(async () => ({ jobId: "job-1" })),
```

Add a new `vi.mock` call alongside the existing ones:

```ts
vi.mock("@/lib/style-ref-jobs", () => ({
  submitStyleRefJobForUser: spies.submitStyleRefJobForUser,
  getStyleRefJobForUser: vi.fn(),
}));
```

Add a new row to the `TIER_2_CALLS` array:

```ts
  ["generate_style_ref", { categoryId: "cat-1" }, "generate a new brand reference image for category cat-1 (spends API credit)"],
```

- [ ] **Step 6: Run the test to verify it fails without the tool wired up correctly, then passes**

This test should already pass once Steps 2-3 are done correctly (the tool already calls `assertConfirmed`), but run it to confirm:

Run: `npx vitest run tests/mcp-tier2-gate.test.ts`
Expected: PASS, including the new `generate_style_ref` row in the `it.each` loop.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all tests pass, including the updated `tests/mcp-tier2-gate.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add app/api/mcp/route.ts tests/mcp-tier2-gate.test.ts
git commit -m "feat: generate_style_ref and get_style_ref_job MCP tools"
```

---

## Final verification

- [ ] **Run the full suite:** `npm test` — every test passes.
- [ ] **Typecheck:** `npx tsc --noEmit` — clean.
- [ ] **Lint:** `npm run lint` — clean.
- [ ] **Build:** `npm run build` — succeeds.
- [ ] **Manual, with real keys and migration 0019 applied:** call `generate_style_ref` against a real category via an MCP client, confirm it returns `{jobId}` immediately (well under 120s). Wait for the cron route to tick (or hit `GET /api/jobs/poll` with the correct `CRON_SECRET` bearer token manually), then call `get_style_ref_job` with the returned `jobId` and confirm it eventually reports `status: "succeeded"` with a real `styleRefUrl`, and that the category's `style_ref_url` in Supabase reflects the same URL.
- [ ] **Manual: confirmation gate.** Call `generate_style_ref` without `confirm: true` and confirm it returns the "Not confirmed" error without submitting anything to Kie or inserting a job row.
- [ ] **Manual: cross-tenant guard.** Call `generate_style_ref` with a `categoryId` belonging to a different tenant and confirm it errors with "unknown category" rather than generating against someone else's category.
