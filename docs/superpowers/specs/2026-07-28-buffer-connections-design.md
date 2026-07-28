# Buffer Connections — Design Spec (Post Menu, Phase 1 of 3)

**Date:** 2026-07-28
**Status:** approved for planning
**Depends on:** multi-tenant Buffer personal keys (migration 0007, `getValidBufferToken` boundary).
**Part of:** the Post Menu project — Phase 1 (channel foundation) of: 1) this, 2) ready-queue + Buffer-style composer, 3) multi-channel adapted copy.

## 1. Summary

Today one Buffer personal token lives on `user_settings`, and three legacy categories point at channels belonging to a *different* Buffer login — unpostable since multi-tenancy replaced the shared two-token routing. This phase makes Buffer connections first-class: N named connections per user, categories bound to a connection + channel, posting resolving the right token, and `posts` rows gaining the grouping/channel columns Phases 2-3 build on. Same personal-key model as today (OAuth stays deferred); this is plumbing plus a small Config surface, no composer changes.

## 2. Schema (migration 0012)

- `buffer_connections`: `id uuid pk default gen_random_uuid()`, `user_id uuid not null references auth.users`, `label text not null`, `buffer_token_enc text not null`, `created_at`/`updated_at` timestamptz defaults. RLS: owner-all (`auth.uid() = user_id`), same policy shape as `categories` in migration 0005.
- **In-SQL backfill:** for every `user_settings` row with non-empty `buffer_token_enc`, insert one connection `label = 'Default'` copying the encrypted token verbatim (encrypted at rest — a straight copy is valid). The old `user_settings.buffer_token_enc` column REMAINS but is no longer read or written after this phase (rollback safety; drop later).
- `categories.buffer_connection_id uuid references buffer_connections on delete set null`, nullable. **In-SQL backfill:** every category with a non-empty `buffer_channel_id` points at its user's just-created Default connection.
- `posts.post_group_id uuid not null default gen_random_uuid()` — one row per Buffer update; Phase 3 groups N channel rows under one group id. Phase 1-2 posts are groups of one.
- `posts.buffer_channel_id text not null default ''` — records where the post went; written at create from this phase on.

## 3. Token boundary

`lib/settings/buffer.ts` reworks around connections:

- `listBufferConnections(userId): Promise<{ id, label, connected: true }[]>` — admin client, `eq user_id` (tokens never returned).
- `addBufferConnection(userId, label, token)` / `removeBufferConnection(userId, connectionId)` (delete the row; `categories.buffer_connection_id` goes null via FK, surfacing as "reconnect" in the editor).
- `getBufferTokenForConnection(userId, connectionId): Promise<string>` — throws a clear message when the connection is missing or not the caller's. This becomes the boundary every downstream Buffer call goes through.
- `getValidBufferToken(userId)` survives as a thin back-compat shim: the user's single connection if exactly one exists, else it throws asking to specify — remaining callers migrate in this phase, so post-phase it should have no callers (delete it if none remain; keep the shim only if a caller genuinely can't know a connection).
- `storeBufferToken`/`disconnectBuffer`/`getBufferStatus` are replaced by the connection functions; the Config UI stops using them.

## 4. Posting path

`app/api/posts/create/route.ts`: resolve the category's `buffer_connection_id` → `getBufferTokenForConnection` → `postToBuffer(token, cat.buffer_channel_id, ...)` unchanged after that. A category with a channel but null connection (legacy, or connection deleted) fails with a clear "pick this category's Buffer connection in Config" message. The insert writes `buffer_channel_id` (and `post_group_id` defaults itself).

## 5. Config UI

- **Buffer connections section** (replacing the single connect box in `/config`): list of connections (label + channel count fetched per token), an add form (label + personal key, same paste-a-key flow as today), disconnect per connection with a confirm. Channel-count fetch failure on a connection shows inline ("key invalid or expired") without breaking the page.
- **Category editor channel dropdown:** options grouped by connection (`<optgroup label={connection.label}>`), values carrying `(connection_id, channel_id, service)` — one select, encoded value split on save. Saving writes all three columns. A category whose `buffer_connection_id` is null but has a `buffer_channel_id` shows an inline warning ("channel belongs to a disconnected/unassigned account — re-pick it").
- The page fetches channels per connection server-side (parallel, per-connection failure tolerated) and passes a `{ connectionId, label, channels }[]` prop down.

## 6. Error handling

- Missing/foreign connection at post time or channel-list time: clear message naming the category and pointing at Config, existing 4xx/5xx route conventions.
- A deleted connection nulls category FKs (DB-level `on delete set null`) — the editor warning in §5 is the recovery surface.

## 7. Testing

- Pure/unit: the select-value encode/split helper; `getBufferTokenForConnection` error paths are IO — covered by compile + conventions like the other secret helpers (untested today, consistent).
- Existing suite must stay green; `npm run build`/tsc/eslint battery per repo standard.
- Human verification post-merge: add the second Buffer login as a connection, re-point the three legacy categories, post one image from a legacy category.

## 8. Out of scope

- The composer/ready-queue (Phase 2), multi-channel fan-out + adapted copy (Phase 3), OAuth, dropping `user_settings.buffer_token_enc`, auto-migrating the three legacy categories' channel choices (human re-picks them — the whole point is they belong to a token we don't have yet).
