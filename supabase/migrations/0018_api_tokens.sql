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
