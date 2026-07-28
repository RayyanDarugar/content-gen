-- supabase/migrations/0010_role_ref_urls.sql
-- Cementing: a successful test run can be promoted to per-role reference
-- images. The brand style_ref_url inspires a category; once it produces a
-- good post, that output becomes the reference — the image carries each
-- role's treatment instead of role_guides prose fighting the anchor image.
-- Keyed by slide role, values are durable Cloudinary URLs:
--   { "hook": url, "beat": url, "payoff": url, "single": url }
-- style_ref_url remains the fallback for any role without a ref.
alter table categories add column role_ref_urls jsonb not null default '{}'::jsonb;
