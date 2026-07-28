-- supabase/migrations/0011_post_copy.sql
-- AI-written post copy (spec 2026-07-28-ai-post-copy-design.md).
-- The mode is the guide's presence: non-empty caption_guide means the idea
-- call also writes post_text for this category; empty means the rotating
-- post_caption variants keep working untouched.
alter table categories add column caption_guide text not null default '';

-- The Buffer channel's service ("linkedin", "twitter", "instagram", ...),
-- captured client-side when the channel is picked in Config — generation
-- derives the platform preset from it without a live Buffer call. Empty
-- (pre-existing rows until their next save) falls back to a generic preset.
alter table categories add column buffer_channel_service text not null default '';

-- The copy draft written at idea time; edited (not persisted) at post time.
alter table ideas add column post_text text not null default '';
