-- supabase/migrations/0006_byok_brand.sql
-- Phase B: per-user encrypted API keys, brand context, and a per-category
-- output-format field. Buffer columns are untouched (Phase C).

create table user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  anthropic_key_enc text not null default '',
  kie_key_enc text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger user_settings_updated_at before update on user_settings
  for each row execute function set_updated_at();

create table brand_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  business_name text not null default '',
  business_description text not null default '',
  audience text not null default '',
  voice text not null default '',
  avoid text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger brand_profiles_updated_at before update on brand_profiles
  for each row execute function set_updated_at();

alter table categories add column output_format text not null default '';

alter table user_settings enable row level security;
alter table brand_profiles enable row level security;

create policy "owner all" on user_settings for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner all" on brand_profiles for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
