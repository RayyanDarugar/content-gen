-- supabase/migrations/0009_post_type_and_role_guides.sql
-- Phase A follow-up: a category is either a set of independent standalone
-- images or one narrative sequence, and the two need different prompting.
--
-- 0008 read images_per_carousel = 5 as "this is a five-part story" and applied
-- slide roles and anchor chaining to every category. Four of five aren't
-- stories. SAT_MYTH's style guide describes a standalone poster — an orange
-- MYTH tag and a hand-drawn X through the statement — so applying it to every
-- slide produced a payoff panel reading "MYTH: <the correct insight>" with a
-- red X through it. The format inverted its own meaning.
--
-- Defaulting to 'independent' is the point: nothing changes for any existing
-- category until it is explicitly opted in.

alter table categories
  add column post_type text not null default 'independent'
  check (post_type in ('independent', 'narrative'));

-- A narrative row needs at least a hook and a payoff to be a story; the
-- server action already enforces this, but a row can also arrive via seed
-- script or a direct DB edit, bypassing it. Without this constraint,
-- narrative + images_per_carousel = 1 makes the idea prompt ask for "ONE
-- carousel of exactly 1 slides" while validateSlideShape(slides, 1) demands
-- role "single" — every idea gets discarded and the run dies with "Claude
-- returned zero usable ideas" and no clue why. Validates cleanly against
-- existing rows: they are all 'independent' by default.
alter table categories
  add constraint categories_narrative_needs_2_slides
  check (post_type = 'independent' or images_per_carousel >= 2);

-- What differs per panel type, keyed by slide role:
--   { "hook": "...", "beat": "...", "payoff": "...", "single": "..." }
-- style_guide keeps what is SHARED across every panel (palette, character,
-- typography, any persistent footer); role_guides holds the treatment that
-- belongs to one role only — e.g. the MYTH tag and X on the hook, and
-- explicitly not on the beats or the payoff.
alter table categories add column role_guides jsonb not null default '{}'::jsonb;
