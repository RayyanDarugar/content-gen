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
