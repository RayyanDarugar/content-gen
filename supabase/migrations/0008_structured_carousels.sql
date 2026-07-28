-- supabase/migrations/0008_structured_carousels.sql
-- A post becomes one structured unit: an idea carries an ordered array of
-- slides, and each generation names both its slide and the anchor image it
-- was generated against.

alter table ideas add column slides jsonb not null default '[]'::jsonb;

alter table generations add column slide_index int not null default 0;
create index generations_idea_slide_idx on generations(idea_id, slide_index);

-- Which slide-0 image this slide was generated against. Null for slide 0
-- itself and for legacy/single-slide rows. Makes carousel membership
-- explicit so regenerating an anchor can't silently orphan its siblings.
alter table generations add column anchor_generation_id uuid references generations(id);
create index generations_anchor_idx on generations(anchor_generation_id);

-- Null means the post was hand-assembled from the freeform pool; non-null
-- means the post is that carousel. Legacy posts stay null — each of them
-- groups five unrelated ideas, so they have no single owning idea.
alter table posts add column idea_id uuid references ideas(id);

-- Legacy ideas become single-slide carousels so there is exactly one code
-- path. These are historical records, not regeneration targets: a legacy
-- BEAGLE_EXPLAINS idea correctly ends up with one slide despite its
-- category's images_per_carousel = 5, because one image is what it produced.
update ideas
set slides = jsonb_build_array(
  jsonb_build_object('role', 'single', 'text', '', 'visual', concept))
where slides = '[]'::jsonb and concept <> '';
