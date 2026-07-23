-- supabase/migrations/0007_buffer_token.sql
-- Phase C: per-user Buffer personal API key (BYOK — same pattern as the
-- Anthropic/Kie keys from migration 0006). OAuth is a deferred future
-- upgrade; see docs/superpowers/plans/2026-07-23-multi-tenant-phase-c-buffer-oauth.md.
-- getValidBufferToken() in lib/settings/buffer.ts is the abstraction boundary
-- that lets that upgrade land later without touching any of its callers.

alter table user_settings add column buffer_token_enc text not null default '';
