-- supabase/migrations/0022_overlay_slots.sql
-- Overlay slots, B2 (spec 2026-08-11-overlay-slots-design.md).
--
-- B1 gave a category a fixed overlay image (a logo, a QR code). A slot is the
-- same placement with the image left to each idea: "speaker photo,
-- bottom-left, 35%, on the hook slide", filled twelve different ways across a
-- twelve-speaker series.

-- Explicit rather than inferred from an empty image_url: inferring would let a
-- mis-saved blank silently turn a logo into a slot, which fails quietly — the
-- logo just stops appearing and nothing says why.
alter table category_overlays add column is_slot boolean not null default false;

-- B1's spec proposed a `slot_key` string. It is deliberately NOT added: fills
-- join on overlay_id, so a key would only ever be a human label, and `name`
-- already is one.
create table idea_overlay_fills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idea_id uuid not null references ideas(id) on delete cascade,
  -- Cascade: deleting a slot deletes its fills. The images stay in Cloudinary,
  -- consistent with every other upload in this app.
  overlay_id uuid not null references category_overlays(id) on delete cascade,
  image_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (idea_id, overlay_id)
);

-- The read is always "this idea's fills".
create index idea_overlay_fills_idea_idx on idea_overlay_fills(idea_id);

alter table idea_overlay_fills enable row level security;
create policy "owner all" on idea_overlay_fills for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger idea_overlay_fills_updated_at before update on idea_overlay_fills
  for each row execute function set_updated_at();
