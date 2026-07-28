-- supabase/migrations/0012_buffer_connections.sql
-- Post Menu phase 1 (spec 2026-07-28-buffer-connections-design.md).
-- Buffer connections become first-class: N named personal keys per user.
-- user_settings.buffer_token_enc remains on disk but is no longer read or
-- written after this migration's code ships (rollback safety; drop later).

create table buffer_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  buffer_token_enc text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table buffer_connections enable row level security;
create policy "owner all" on buffer_connections
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Backfill: every user with a token gets one connection. The value is
-- already encrypted at rest, so a verbatim copy is a valid token row.
insert into buffer_connections (user_id, label, buffer_token_enc)
select user_id, 'Default', buffer_token_enc
from user_settings where buffer_token_enc <> '';

-- A category's home connection. on delete set null: removing a connection
-- surfaces as "re-pick this category's channel" in the editor, never a
-- dangling reference.
alter table categories
  add column buffer_connection_id uuid references buffer_connections(id) on delete set null;

update categories c
set buffer_connection_id = bc.id
from buffer_connections bc
where bc.user_id = c.user_id and bc.label = 'Default' and c.buffer_channel_id <> '';

-- Phase 2-3 groundwork: one posts row per Buffer update, groupable later;
-- and a record of which channel the update went to.
alter table posts add column post_group_id uuid not null default gen_random_uuid();
alter table posts add column buffer_channel_id text not null default '';
