-- supabase/migrations/0023_overlay_treatments.sql
-- Overlay treatments, B3 (spec 2026-08-11-overlay-treatments-design.md).
--
-- Background removal was cut on cost, so an uploaded headshot arrives as a
-- rectangle carrying whatever background it was shot against. A circular mask
-- with a border does most of what a cutout would have — it crops the
-- background out of frame — and a shadow is what stops the result reading as
-- a rectangle pasted onto generated art.
--
-- Every column defaults to today's behaviour, so existing overlays render
-- exactly as they do now.

alter table category_overlays
  add column shape text not null default 'none'
    check (shape in ('none','circle','rounded')),
  -- Percentage of the LAYER's own width, like size_pct, so a border looks
  -- right on a 15% logo and a 35% headshot alike.
  add column border_width_pct numeric not null default 0,
  add column border_color text not null default '',
  -- 'color' rather than B1's proposed 'brand': the compositing path has no
  -- brand awareness, and coupling image rendering to the brand record buys
  -- only automatic re-branding of FUTURE posts, which editing one field
  -- already achieves.
  add column tint text not null default 'none'
    check (tint in ('none','grayscale','color')),
  add column tint_color text not null default '',
  -- A boolean, not a set of knobs: offset and blur are derived from the
  -- layer's width so nothing needs tuning and nothing can be set badly.
  add column shadow boolean not null default false;
