-- supabase/migrations/0021_category_overlays.sql
-- Asset compositing B1 (spec 2026-08-10-asset-compositing-design.md).
--
-- A QR code that actually scans can never come from a generative model, so
-- exact assets are composited onto the finished image instead. Configured per
-- category, alongside role_guides/role_ref_urls, and targeted by role.

create table category_overlays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  name text not null,
  image_url text not null,
  -- any subset of hook/beat/payoff/single; an empty array is rejected at the
  -- validation layer rather than silently compositing nowhere.
  roles text[] not null,
  corner text not null check (corner in ('top-left','top-right','bottom-left','bottom-right','center')),
  margin_pct numeric not null default 5,
  -- overlay WIDTH as a percentage of the base image's width; height follows
  -- from the overlay's own aspect ratio. Percentages so placement survives
  -- this app's different aspect ratios (4:5, 1:1).
  size_pct numeric not null default 15,
  opacity numeric not null default 100,
  -- stacking order when several overlays target the same role
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index category_overlays_category_idx on category_overlays(category_id);

alter table category_overlays enable row level security;
create policy "owner all" on category_overlays for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger category_overlays_updated_at before update on category_overlays
  for each row execute function set_updated_at();

-- The second artifact. generations.public_url keeps its existing meaning —
-- the CLEAN image — because fanOutCarousel/sweepOrphanedAnchors and
-- lib/athena/resubmit-slide.ts all hand it to Kie as the carousel anchor.
-- Compositing in place would burn the overlay into the model's visual
-- reference for every later slide. Empty string, not null, matching
-- public_url's existing convention.
alter table generations add column composited_url text not null default '';
