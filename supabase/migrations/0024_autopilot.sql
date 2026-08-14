-- supabase/migrations/0024_autopilot.sql
-- Scheduled workflows / autopilot (spec 2026-08-14-scheduled-workflows-design.md).
--
-- Autopilot is a quota the system reconciles, not a job that fires at a time.
-- A workflow says "this category publishes N times per period"; a run is one
-- attempt at closing that gap. A failed attempt needs no retry machinery — it
-- simply leaves the gap open for the next tick, bounded by the caps below.

create table autopilot_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- unique: exactly one answer to "what is this category's cadence?"
  category_id uuid not null references categories(id) on delete cascade,
  posts_per_period int not null default 1 check (posts_per_period between 1 and 10),
  period text not null default 'day' check (period in ('day', 'week')),
  timezone text not null default 'America/Los_Angeles',
  max_attempts_per_period int not null default 3
    check (max_attempts_per_period between 1 and 10),
  auto_pause_after_failed_periods int not null default 3
    check (auto_pause_after_failed_periods >= 1),
  consecutive_failed_periods int not null default 0,
  -- The last local period this workflow was judged for. Null on a brand-new
  -- workflow, which is why the first sighting settles without judging.
  last_settled_period date,
  -- When the sweep last examined this workflow. The tick orders by it (nulls
  -- first) and stamps every workflow it pulls, so a fixed per-tick cap rotates
  -- through all of them; ordering by created_at instead would examine only the
  -- oldest N forever and starve the tail permanently once the cap is exceeded.
  last_ticked_at timestamptz,
  active boolean not null default true,
  paused_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (category_id)
);

-- No brand_id column: the brand is read from the category (categories.brand_id),
-- which is what generateIdeas needs for loadBrandContext. A second copy would
-- be one more enumerated column to keep in sync, and this codebase has already
-- been bitten by that.
create table autopilot_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references autopilot_workflows(id) on delete cascade,
  category_key text not null,
  period_start date not null,
  attempt_no int not null,
  -- 'publishing' is the claim state: the tick conditionally moves a run into it
  -- before calling Buffer, so an overlapping tick that read the same run finds
  -- the update matching no rows and declines to post the carousel twice.
  state text not null
    check (state in
      ('sourcing', 'awaiting_images', 'posting', 'publishing', 'succeeded', 'failed')),
  source text not null default ''
    check (source in ('', 'retry_images', 'ready_images', 'approved_idea', 'generated')),
  -- set null, never cascade: deleting an idea must not erase the record of the
  -- run that published it.
  idea_id uuid references ideas(id) on delete set null,
  post_group_id uuid,
  error text not null default '',
  -- Append-only [{at, step, detail}] display log, so the UI can say what
  -- happened rather than only where it stopped. Never read for control flow.
  steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Two overlapping ticks cannot both open the same attempt.
  unique (workflow_id, period_start, attempt_no)
);

create index autopilot_runs_workflow_period_idx
  on autopilot_runs(workflow_id, period_start);
-- The tick's hottest read: "does this workflow have a run in flight?"
create index autopilot_runs_live_idx on autopilot_runs(workflow_id)
  where state in ('sourcing', 'awaiting_images', 'posting', 'publishing');
-- Claim check during sourcing: "is this idea already spoken for?"
create index autopilot_runs_idea_idx on autopilot_runs(idea_id)
  where state in ('sourcing', 'awaiting_images', 'posting', 'publishing');
-- The sweep's ordering: least-recently-ticked first, nulls (never ticked) ahead
-- of everything.
create index autopilot_workflows_sweep_idx
  on autopilot_workflows(last_ticked_at nulls first) where active;

alter table autopilot_workflows enable row level security;
create policy "owner all" on autopilot_workflows for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table autopilot_runs enable row level security;
create policy "owner all" on autopilot_runs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger autopilot_workflows_updated_at before update on autopilot_workflows
  for each row execute function set_updated_at();
create trigger autopilot_runs_updated_at before update on autopilot_runs
  for each row execute function set_updated_at();
