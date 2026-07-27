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

-- What differs per panel type, keyed by slide role:
--   { "hook": "...", "beat": "...", "payoff": "...", "single": "..." }
-- style_guide keeps what is SHARED across every panel (palette, character,
-- typography, any persistent footer); role_guides holds the treatment that
-- belongs to one role only — e.g. the MYTH tag and X on the hook, and
-- explicitly not on the beats or the payoff.
alter table categories add column role_guides jsonb not null default '{}'::jsonb;
