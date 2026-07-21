-- supabase/migrations/0004_posts_error.sql
-- Phase 3: record Buffer failure detail on posts.
alter table posts add column error text not null default '';
