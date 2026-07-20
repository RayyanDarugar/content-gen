create extension if not exists "pgcrypto";

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table categories (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  style_guide text not null default '',
  style_ref_url text not null default '',
  post_caption text not null default '',
  buffer_channel_id text not null default '',
  buffer_account int not null default 1 check (buffer_account in (1, 2)),
  images_per_carousel int not null default 5,
  aspect_ratio text not null default '4:5',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger categories_updated_at before update on categories
  for each row execute function set_updated_at();

create table ideas (
  id uuid primary key default gen_random_uuid(),
  category_key text not null references categories(key),
  concept text not null,
  resolved_prompt text not null,
  ai_filter_reason text not null default '',
  approved boolean not null default false,
  status text not null default 'pending_review' check (status in
    ('pending_review','approved','rejected','generating','generated','posted','failed')),
  batch_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ideas_status_idx on ideas(status);
create index ideas_category_idx on ideas(category_key);
create trigger ideas_updated_at before update on ideas
  for each row execute function set_updated_at();

create table generations (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references ideas(id),
  kie_task_id text not null default '',
  status text not null default 'submitted' check (status in
    ('submitted','polling','succeeded','failed')),
  poll_count int not null default 0,
  kie_style_url text not null default '',
  full_prompt text not null default '',
  image_path text not null default '',
  public_url text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index generations_status_idx on generations(status);
create trigger generations_updated_at before update on generations
  for each row execute function set_updated_at();

create table posts (
  id uuid primary key default gen_random_uuid(),
  category_key text not null references categories(key),
  buffer_update_id text not null default '',
  caption text not null default '',
  status text not null default 'created' check (status in ('created','queued','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger posts_updated_at before update on posts
  for each row execute function set_updated_at();

create table post_images (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id),
  generation_id uuid not null references generations(id),
  sort_order int not null default 0
);

-- RLS: single-user app; authenticated users get full access, anon gets nothing.
alter table categories enable row level security;
alter table ideas enable row level security;
alter table generations enable row level security;
alter table posts enable row level security;
alter table post_images enable row level security;

create policy "auth full access" on categories for all to authenticated using (true) with check (true);
create policy "auth full access" on ideas for all to authenticated using (true) with check (true);
create policy "auth full access" on generations for all to authenticated using (true) with check (true);
create policy "auth full access" on posts for all to authenticated using (true) with check (true);
create policy "auth full access" on post_images for all to authenticated using (true) with check (true);
