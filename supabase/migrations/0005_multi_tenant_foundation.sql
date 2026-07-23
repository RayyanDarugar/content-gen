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
