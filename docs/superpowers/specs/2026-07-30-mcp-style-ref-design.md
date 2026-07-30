# MCP Style Reference Generation — Design Spec

**Date:** 2026-07-30
**Status:** approved for planning
**Depends on:** the auto-generated style reference feature (merge `b3e8ca3` — `lib/athena/style-ref-prompt.ts`, `lib/athena/kie.ts`'s `createTextToImageKieTask`, `POST /api/categories/draft/style-ref`); the MCP agent integration (merge `ba4c341` — `app/api/mcp/route.ts` and its existing 24 tools); the existing image-generation cron poller (`app/api/jobs/poll/route.ts`).

## 1. Summary

The MCP server exposes 24 tools today, but none of them can trigger the brand-reference-image generation that Test Run and Regenerate already do in the browser. `update_category` can only accept a `style_ref_url` the caller already has; there is no way for an MCP agent to generate one.

This closes that gap with two new tools — `generate_style_ref` and `get_style_ref_job` — backed by a new small job-tracking table and one new section in the existing cron poller. First-time generation and regeneration are the same MCP verb: an optional `notes` parameter distinguishes them, exactly as the browser's Regenerate button already does by calling the same underlying function with or without notes.

## 2. Why this isn't a thin wrapper like the other 24 tools

Every other slow, Kie-touching tool in this server (`submit_image_generation`, `resubmit_slide`) is fire-and-forget: it submits a Kie task, writes a database row, and returns immediately. A separate cron tick (`app/api/jobs/poll/route.ts`) polls those rows to completion later.

The browser's own style-ref generation (`lib/style-ref-client.ts`'s `generateStyleRef`/`persistStyleRef`) does the opposite — it polls Kie to completion itself, synchronously, for up to 5 minutes. That shape cannot be exposed directly as an MCP tool: `app/api/mcp/route.ts` sets `maxDuration = 120`, so a tool call blocking the full 5 minutes would be killed by the platform before Kie finishes, failing the request outright. And unlike the fire-and-forget tools, there is no existing table or cron logic tracking a pending style-ref job — a bare "submit and hope" tool would leave the Kie task orphaned, generating an image on Kie's side that nothing ever comes back to re-host or persist.

So this is genuinely new infrastructure, sized to match the existing async pattern rather than improvised around the timeout.

## 3. `style_ref_jobs` table (migration 0019)

```sql
create table style_ref_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  kie_task_id text not null,
  status text not null default 'submitted' check (status in ('submitted','polling','succeeded','failed')),
  style_ref_url text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index style_ref_jobs_user_idx on style_ref_jobs(user_id);
create index style_ref_jobs_pending_idx on style_ref_jobs(status) where status in ('submitted','polling');

alter table style_ref_jobs enable row level security;
create policy "owner all" on style_ref_jobs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

`style_ref_url` is a convenience denormalization, stamped by the cron poller once the job succeeds — mirroring how `generations.public_url` stores its resolved URL directly on the row rather than requiring the caller to join back to `categories`. Standard owner-scoped RLS, the same shape as every other table in this schema.

## 4. `generate_style_ref` MCP tool

Input: `{ categoryId: string, notes?: string, confirm?: boolean }`.

Matches `submit_image_generation`'s existing shape: requires `assertConfirmed({confirm}, ...)` since it spends real Kie credit, with the confirmation summary naming the category id. A new server function, `submitStyleRefJob(userId, categoryId, notes?)`, does the actual work. Unlike the browser routes, the MCP server has no cookie-based session — `app/api/mcp/route.ts`'s other tools already use `createAdminSupabase()` with an explicit `.eq("user_id", userId)` filter on every query (see `list_categories`/`get_category` in that file), since there is no RLS-scoped client to lean on automatically. This function follows the same shape:

1. Load the category **filtered by both `id` and `user_id`** (never `id` alone) via `createAdminSupabase()`, and throw a clear "unknown category" error if nothing matches — this is the only thing standing between an authenticated MCP caller and generating (and, once the job succeeds, silently persisting) an image against another tenant's category. Load the brand profile the same way (field-by-field `BrandContext` construction already used by the existing `/api/categories/draft/style-ref` "generate" phase and by `/api/categories/suggest`).
2. Build the prompt via the existing `buildStyleRefPrompt(brand, notes)` — no new prompt logic, this task is reused verbatim.
3. Call the existing `createTextToImageKieTask(kieKey, prompt, category.aspect_ratio)` — no new Kie logic either.
4. Insert a `style_ref_jobs` row (`status: "submitted"`, the returned `kie_task_id`).
5. Return `{ jobId, status: "submitted" }`.

The tool returns immediately — it never polls, never blocks past the initial Kie submission call.

## 5. `get_style_ref_job` MCP tool

Input: `{ jobId: string }`. Reads the `style_ref_jobs` row (RLS-scoped to the caller automatically), returns `{ status, error, styleRefUrl }`. This is the only way an MCP agent learns whether a submitted job finished, failed, or is still in flight — deliberately not folded into `get_category`, so the agent can distinguish "still generating" from "failed" from "never happened" without extra bookkeeping of its own.

## 6. Cron integration — one new function, no new route

Add `pollStyleRefJobs(supabase)` to `app/api/jobs/poll/route.ts`, called from the existing `POST` handler alongside the current generations-polling logic — not a new route, not a new external cron trigger. Whatever already schedules a hit on this endpoint continues to work unchanged and now covers style-ref jobs too.

For each row with `status in ('submitted', 'polling')`, capped (e.g. 10 per tick — these are single-image, no-fan-out jobs, so a smaller cap than `INGEST_CAP` is appropriate):

1. `getKieRecord(kieKey, kie_task_id)` — the caller's Kie key resolved the same way the rest of this route already resolves it (`getKieKeyOrNull`).
2. On success (`state: "success"`): fetch the result URL, re-host via the already-imported `uploadImageToCloudinary`, then in one update: write `categories.style_ref_url` AND the job row (`status: "succeeded"`, `style_ref_url`).
3. On failure (`state: "fail"`): mark the row `status: "failed"` with the error message. Never left silently stuck.
4. Anything else: leave `status: "polling"` for the next tick.

No retry/backoff logic beyond a single poll-and-advance per tick — unlike carousel fan-out, job volume here is low (one-off test-run/regenerate triggers via an agent, not batch spam), so this doesn't need the same tolerance machinery.

## 7. Testing

No new pure-function surface — `submitStyleRefJob` and `pollStyleRefJobs` both reuse existing, already-tested logic (`buildStyleRefPrompt`, `createTextToImageKieTask`, `uploadImageToCloudinary`) end to end via live Kie/Cloudinary/Supabase calls. Consistent with the rest of this codebase, neither gets an automated test — no live-LLM or live-Kie tests exist anywhere in this repo, and this doesn't change that.

## 8. Out of scope

- Retry/backoff logic on the cron side beyond a single poll-and-advance per tick.
- Any browser UI surface for `style_ref_jobs` — this is MCP-only. The browser keeps using its existing synchronous `generateStyleRef`/`persistStyleRef` path, completely unchanged.
- Rate-limiting or de-duplicating concurrent `generate_style_ref` calls for the same category — mirrors how `submit_image_generation` doesn't guard against duplicate submissions either.
