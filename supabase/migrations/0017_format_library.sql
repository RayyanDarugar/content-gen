-- supabase/migrations/0017_format_library.sql
-- Suggested post types, spec §3. A "format" is a post structure worth
-- reusing: how the slides are shaped, why that shape works, where it came
-- from, and what kind of brand can carry it.
--
-- This is project 2's Format object arriving early. It lands ahead of the
-- full Brand/Format/Series split deliberately: the suggestion lane needs a
-- place for structures to accumulate, and retrofitting provenance onto
-- categories later is more expensive than adding one nullable column now.

create table formats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  structure text not null,
  why_it_works text not null default '',
  source_example text not null default '',
  brand_fit text not null default '',
  screenshot_url text not null default '',
  -- 'observed' = a real post a human saw work, captured through the
  -- authoring surface; carries a human vouch. 'invented' = model-derived,
  -- promoted because a suggestion stuck. A future scraper adds 'scraped',
  -- which will be the only origin ever carrying verified metrics.
  origin text not null check (origin in ('observed', 'invented')),
  shared boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index formats_user_idx on formats(user_id);
-- The suggestion route's only read: every visible, usable row.
create index formats_visible_idx on formats(shared, active);

create trigger formats_updated_at before update on formats
  for each row execute function set_updated_at();

alter table formats enable row level security;

-- Read is deliberately NOT pure owner-isolation. This is the first such
-- table in the schema, which is why it gets its own verification script.
create policy "read shared or own" on formats for select to authenticated
  using (shared or auth.uid() = user_id);

-- shared is never settable through the app: both write policies require the
-- resulting row to have shared = false. Promoting a format into the shared
-- library is a manual UPDATE in Supabase, and that manual step IS the
-- curation gate.
--
-- Deliberate consequence: a row that is already shared cannot be updated by
-- anyone through the app, including its author, because the with-check would
-- fail. Editing a shared format is a SQL edit. The shared set is small and
-- curated, so this is accepted rather than worked around.
create policy "insert own unshared" on formats for insert to authenticated
  with check (auth.uid() = user_id and shared = false);
create policy "update own unshared" on formats for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and shared = false);
create policy "delete own" on formats for delete to authenticated
  using (auth.uid() = user_id);

-- Provenance ONLY. The approved translation lives verbatim in the category's
-- own columns; re-deriving a category from its format on every run would
-- silently change behavior when the format is edited. on delete set null so
-- retiring a format never destroys a user's post type.
alter table categories
  add column source_format_id uuid references formats(id) on delete set null;

-- Append-only log of what was proposed, written at suggest time — before the
-- user engages — because impressions are the point. Without them, a format
-- shown 100 times and converting 5 is indistinguishable from one shown 5
-- times and converting 5.
create table format_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- null means the model invented the structure rather than drawing on the
  -- library; invented_format then holds what it conceived.
  format_id uuid references formats(id) on delete set null,
  concept text not null default '',
  invented_format jsonb,
  -- Stamped on first persist. Still null = the suggestion was never kept.
  category_id uuid references categories(id) on delete set null,
  created_at timestamptz not null default now()
);

create index format_suggestions_user_idx on format_suggestions(user_id);
create index format_suggestions_format_idx on format_suggestions(format_id);

alter table format_suggestions enable row level security;
create policy "owner all" on format_suggestions for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
