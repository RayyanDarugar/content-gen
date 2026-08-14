# Scheduled Workflows (Autopilot) — Design Spec

**Date:** 2026-08-14
**Status:** approved for planning
**Builds on:** the existing three-stage pipeline — `generateIdeas` (`lib/athena/generate-ideas.ts`), `submitGenerations` (`lib/athena/submit-generations.ts`) plus the poll cron (`app/api/jobs/poll/route.ts`), and `scheduleValidatedPost` / `createPostForUser` (`app/api/posts/create/route.ts`).

## 1. Summary

Athena's whole pipeline works, and every stage is a button someone presses. This spec removes the person from the middle of it: *"in each of these categories, publish a carousel a day."*

The feature is **not** a job that fires at 9am. It is a **quota the system reconciles**. Every tick asks one question per category — *has this category landed as many posts this period as its rate demands?* — and if not, pushes one attempt forward by one step. Retry needs no special machinery: a failed attempt simply leaves the gap open, and the next tick opens a fresh attempt against a cap.

The three stages already exist and are already reachable without a browser session. What is new is the bookkeeping that decides *when* to invoke them, *which* material to use, and *when to stop trying*.

## 2. Decisions taken

Recorded because each one closes a fork that a reader would otherwise reopen:

- **No human review gate.** The AI self-filter in `generateIdeas` is the only quality bar. Autopilot approves its own idea and publishes it unseen.
- **Rides Buffer's queue.** Posts are created with `scheduled_at: null`, so Buffer's per-channel queue decides the publish time. Timing lives in Buffer, not here.
- **One workflow per category, each with its own rate.** Not a global "3 posts/day" pool.
- **Existing inventory is fair game.** A fully-generated, unposted carousel is published rather than paying to make a new one — including carousels created by hand in the gallery.
- **The quota counts every post, not just autopilot's.** Post to a category by hand in the morning and autopilot stands down for that period.
- **Three independent spend brakes** (§7), including a workflow that deactivates itself after repeated failure.

## 3. Data model — migration `0024`

```sql
create table autopilot_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  posts_per_period int not null default 1 check (posts_per_period between 1 and 10),
  period text not null default 'day' check (period in ('day', 'week')),
  timezone text not null default 'America/Los_Angeles',
  max_attempts_per_period int not null default 3 check (max_attempts_per_period between 1 and 10),
  auto_pause_after_failed_periods int not null default 3 check (auto_pause_after_failed_periods >= 1),
  consecutive_failed_periods int not null default 0,
  last_settled_period date,
  active boolean not null default true,
  paused_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (category_id)
);

create table autopilot_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references autopilot_workflows(id) on delete cascade,
  category_key text not null,
  period_start date not null,
  attempt_no int not null,
  state text not null check (state in ('sourcing', 'awaiting_images', 'posting', 'succeeded', 'failed')),
  source text not null default '' check (source in ('', 'retry_images', 'ready_images', 'approved_idea', 'generated')),
  idea_id uuid references ideas(id) on delete set null,
  post_group_id uuid,
  error text not null default '',
  steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_id, period_start, attempt_no)
);

create index autopilot_runs_workflow_period_idx on autopilot_runs(workflow_id, period_start);
create index autopilot_runs_live_idx on autopilot_runs(workflow_id)
  where state in ('sourcing', 'awaiting_images', 'posting');
```

Both tables take owner-scoped RLS (`auth.uid() = user_id`, `for all to authenticated`) and the shared `set_updated_at()` trigger, matching every per-tenant table here. The cron reads and writes through the admin client, exactly as `app/api/jobs/poll/route.ts` does — it has no session.

**No `brand_id` column.** The brand is read from the category (`categories.brand_id`), which `generateIdeas` needs for `loadBrandContext`. Duplicating it would create a second copy to keep in sync, and this codebase has already been bitten by enumerated columns drifting from their source.

**`unique (category_id)`** is what makes "each category with its own rate" unambiguous — there is exactly one answer to "what is this category's cadence?"

**`idea_id` is `on delete set null`, not cascade.** A deleted idea must not erase the history of the run that published it.

**`steps` is an append-only jsonb log** of `{ at, step, detail }` entries. It exists so the UI can say *what* happened ("generated 3 ideas, approved 1, submitted anchor") instead of only *where it stopped*. It is display material, never read for control flow.

## 4. The tick

New route `GET /api/jobs/autopilot`, `maxDuration = 120`, authenticated by the same `Authorization: Bearer ${CRON_SECRET}` constant-time comparison as the poll route, failing closed (401) when `CRON_SECRET` is unset. It is registered as a **second cron-job.org job at ~5-minute intervals** — deliberately not folded into the 60s poll job, whose 120s budget is already spent on image ingestion and must not be starved by a 90s Anthropic call.

Per tick, over active workflows whose category is also `active` (cap: 20 workflows per tick):

1. **Compute the current period.** `periodStart` is the local calendar date (or ISO week's Monday) in the workflow's timezone, derived with `Intl.DateTimeFormat` — no new dependency.
2. **Settle the previous period** if `last_settled_period` is older than the current one: recount that period's landed posts, then either bump `consecutive_failed_periods` (unmet) or reset it to 0 (met), and write `last_settled_period`. Auto-pause fires here (§7).
3. **Advance a live run** if one exists for this workflow — one step, then move on to the next workflow. Never two live runs per workflow; the partial index above makes that check cheap.
4. **Otherwise measure the gap.** `landed` = count of distinct `post_group_id` among `posts` rows for this `user_id` + `category_key` with `status != 'failed'` and `created_at >= periodStartUtc`. Distinct groups, because a multi-channel post is several rows of one publication.
5. `landed >= posts_per_period` → nothing to do. Attempts for this period `>= max_attempts_per_period` → nothing to do until the period rolls. Otherwise **open a run** at `sourcing` with the next `attempt_no`.

Every step is one fast DB read plus at most one paid call, so a tick never approaches its budget.

**One cron job, app-wide.** The operator registers it once, the way the poll job already is; tenants never configure anything. A single tick sweeps **every tenant's** workflows through the admin client, exactly as the poll route sweeps every tenant's in-flight generations.

Because that tick has no session, paid calls resolve each tenant's own Anthropic and Kie keys from `workflow.user_id` (`requireAnthropicKey`, `requireKieKey`), the same way `submitGenerations` does. This changes where a missing key shows up: today it is an error message in front of someone clicking a button, and under autopilot it is a 3am failure nobody sees. That is what §7's auto-pause and the run's recorded `error` exist to make visible.

## 5. Sourcing — four tiers, in order

Attempted in order; the first that yields material wins and is recorded in `run.source`.

1. **`retry_images` — the prior failed attempt's carousel.** If an earlier attempt *in this same period* has an `idea_id` whose slides are still fully ready and unposted, reuse it, and carry its `post_group_id` onto the new run. This is the Buffer-failure case: a rejected post leaves the idea unposted with only `status: "failed"` post rows, so the same images should go out again rather than being regenerated. Carrying the group id forward means `createPostForUser`'s existing pre-post cleanup (`app/api/posts/create/route.ts`, the `suppliedPostGroupId` delete) replaces the failed rows instead of accumulating ghosts that would read as "1 queued · 1 failed" forever. → `posting`.
2. **`ready_images` — any fully-generated, unposted carousel** in the category: idea `status = 'generated'`, every declared slide index resolvable to a succeeded generation under the current anchor (`resolveValidSlides`), no non-failed post covering it, and not claimed by another live run. → `posting`.
3. **`approved_idea` — an approved idea with nothing in flight.** `submitGenerations(userId, [ideaId])`. → `awaiting_images`.
4. **`generated` — make new material.** `generateIdeas(userId, brandId, categoryKey, IDEA_BATCH)` with `IDEA_BATCH = 3`, then approve exactly one of the newly-inserted rows (lowest `id` within the returned `batch_id`, for determinism) and submit it. The other two stay at `pending_review` as inventory for the human queue — a deliberate side benefit, since the marginal cost of two extra ideas in one call is near zero and tomorrow's tier 3 may consume them. → `awaiting_images`.

**Tier 4 is capped at one per tick across all workflows.** It makes two Anthropic calls and can take ~90s of the route's 120s budget. Workflows that would have reached tier 4 this tick are left untouched and try again on the next one — the same bounding discipline `INGEST_CAP` and `FAN_OUT_SWEEP_CAP` apply in the poll route. With a 5-minute tick, five categories all starting cold still all source within half an hour, well inside a daily quota.

If every tier is exhausted (e.g. `generateIdeas` returns zero kept ideas because the self-filter rejected the batch), the run fails with that reason and the next attempt tries again against the cap.

## 6. Advancing a run

**`awaiting_images` observes; it never acts.** The poll cron owns fan-out, compositing, and slide retries. Each tick this step re-reads the idea and its generations:

- Every declared slide resolvable to a succeeded generation → `posting`.
- Nothing in `submitted`/`polling` for the idea *and* the run is older than `IMAGE_DEADLINE_MINUTES` (30) → fail the run with the stall reason. This mirrors the poll route's deliberate choice never to re-mark a stuck idea `failed`: the idea keeps its good slides and stays visible, and it is the *run* that fails, reopening the gap for a fresh attempt.
- Otherwise leave it and check again next tick.

**`posting` reuses `scheduleValidatedPost`**, whose signature relaxes from `scheduledAt: string` to `scheduledAt: string | null` (it is already a pass-through to `createPostForUser`, which accepts null). Reuse rather than a parallel path is load-bearing: that function's own comment warns that its validation must never diverge from the HTTP route's, and a second copy inside a cron would be exactly that divergence.

- **Channels** come from the category's configured Buffer connection (`buffer_connection_id`, `buffer_channel_id`, `buffer_channel_service`) — the composer's own default. A category with no connection configured fails the run immediately with a clear message rather than attempting a post.
- **Caption** is `idea.post_text`, falling back to `category.post_caption` when empty.
- **Generation ids** are the resolved slides in slide order, from `resolveValidSlides` — the same ordering the composer submits.
- **`scheduled_at: null`**, riding Buffer's queue.

Outcomes:

- Any channel queued → `succeeded`, `post_group_id` recorded.
- Every channel failed (`allFailed`) → `failed`, with the error and the `post_group_id` recorded so tier 1 can reuse both.
- **Partial multi-channel** (one queued, one failed) → `succeeded` with the failure text kept in `error` and surfaced as a warning in the UI. The quota counts as met and autopilot does not auto-retry the failed channel: per-channel retry is mechanically safe, but the cost of getting it wrong is a duplicate live post, so that stays a human decision from the composer.

## 7. Spend guardrails

Three brakes at three timescales, each independently sufficient:

| Brake | Bounds | Default |
|---|---|---|
| `max_attempts_per_period` | one bad day | 3 attempts per category per period |
| One tier-4 generation per tick | one bad minute | 1 idea-generation call per 5 min, app-wide |
| `auto_pause_after_failed_periods` | one bad week | 3 consecutive unmet periods → `active = false` |

Auto-pause writes a human-readable `paused_reason` ("missed quota 3 periods running; last error: …") and the workflow stays off until switched back on. This is the brake that matters most: a revoked Kie key or a disconnected Buffer account would otherwise burn credit unattended for as long as nobody looks.

Worst case for Athena's five categories: 15 attempts a day, and the whole thing goes quiet on its own after three days of systematic failure.

## 8. UI — `/autopilot`

A server component page under `app/(app)/autopilot`, following the existing `config` page patterns (server actions delegating to `lib/` mutation helpers that take `userId` and are never exported from a `"use server"` file).

**Workflow list** — a row per active category in the current brand: cadence, timezone, on/off toggle, and this period's live state in plain words: *"posted 1/1"*, *"attempt 2 of 3 — generating images"*, *"paused: missed quota 3 periods running"*. A settings dialog per row edits rate, period, timezone, and caps. A **"turn on for every category"** bulk action makes Athena's five one click instead of five.

**Runs feed** — the last ~20 runs across all of the brand's workflows, each showing period, attempt, source tier, state, error, and its `steps` log, with links through to the idea and the post group.

## 9. Testing

The route stays thin glue. The decisions live in pure functions under `lib/autopilot/`, tested with vitest in the shape `poll-logic.ts`, `fanout.ts`, and `queue.ts` already establish:

- `periodStart(now, timezone, period)` — calendar days and ISO weeks across timezones, including a DST transition and a workflow whose local date differs from UTC's.
- `quotaGap(landedGroups, postsPerPeriod, attemptsUsed, maxAttempts)` — the open/closed/exhausted decision.
- `selectSource(candidates)` — tier ordering, including the case where a prior failed attempt's idea is *no longer* postable and must fall through to tier 2.
- `decideRunStep(run, idea, generations, now)` — the `awaiting_images` transition, the stall deadline, and idempotence when called twice on the same state.
- `settlePeriod(workflow, priorLanded, now)` — the counter's bump/reset and the auto-pause threshold.

Route-level behavior gets the same treatment the poll route has: unauthorized without the bearer token, and a tick with no active workflows doing nothing.

## 10. Out of scope for v1

Named so they are choices rather than omissions:

- **MCP tools for managing workflows.** The UI covers it; the tools are easy to add against the same `lib/autopilot/` helpers later.
- **Failure notifications (email/push).** This app has no mailer path, and the password-reset work already flagged the default Supabase mailer as untested. The `/autopilot` page is the surface.
- **Per-workflow channel overrides.** It posts to the category's configured channel, exactly like the composer's default.
- **Per-workflow post-time control.** Buffer's queue owns publish timing by decision (§2).
