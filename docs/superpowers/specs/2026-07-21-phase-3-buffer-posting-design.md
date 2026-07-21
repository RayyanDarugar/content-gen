# Phase 3 — Buffer Posting Design Spec

**Date:** 2026-07-21
**Status:** Approved
**Builds on:** Phases 1–2 (live at content-gen-lilac.vercel.app). Replaces n8n Workflow C (`n8n-files/Athena C — Post Carousels via Buffer.json`).

## 1. Summary

Add TikTok carousel posting via Buffer: a `/post` page where each category auto-fills a proposed image set (editable), with an editable caption pre-filled from a random variant, posting to the channel's Buffer queue via `POST /api/posts/create`. Completes the pipeline; after acceptance, the n8n workflows are retired.

Key simplification vs. the original Phase 3 sketch: images already live in Cloudinary with public URLs on `generations.public_url` (Phase 2 corruption fix), so Workflow C's entire download/re-upload half disappears — posting is selection UI plus one GraphQL call.

Decisions made during brainstorming:
- **Selection:** auto-fill the oldest N postable images per category; user can swap and reorder before posting.
- **Caption:** random pick from the `||`-separated variants in `categories.post_caption`, pre-filled into an editable textarea.
- **Scheduling:** `mode: addToQueue`, `schedulingType: automatic` — exact n8n port; timing stays managed by Buffer's channel schedules.

## 2. Data model

Existing `posts` and `post_images` tables (migration 0001) are used as designed. One addition:

**Migration 0004:** `alter table posts add column error text not null default '';`

Postability definition (server-enforced): a generation is postable when its `status = 'succeeded'`, it is the **latest** generation for its idea (regenerations supersede older ones), and its idea has `status = 'generated'` (approved, image done, not yet posted).

## 3. API — `POST /api/posts/create`

Auth: session via `lib/auth/require-user.ts` (same as other user-facing routes). Server uses service-role client.

Request: `{ category_key: string, generation_ids: string[] (ordered), caption: string }`

Server validation (reject 400 with message on any failure):
- Category exists and is active.
- `generation_ids.length === categories.images_per_carousel` exactly (partial sets blocked, as in n8n).
- Every generation is postable per §2 definition and belongs to the given category.
- No duplicate ideas across the selected generations.

Flow on valid input:
1. Build the Workflow C GraphQL mutation, with one deliberate improvement: the caption is passed as a **GraphQL variable** (`$text: String!`) instead of n8n's manual string-escaping into the query body. Assets: `[{ image: { url: <generations.public_url> } }]` in the request's order. `channelId` from `categories.buffer_channel_id`.
2. POST to `https://api.buffer.com` with the token selected by `categories.buffer_account` → `BUFFER_TOKEN_1` / `BUFFER_TOKEN_2`. Exact auth header shape (e.g. `Authorization: Bearer <token>`) is unknown from the n8n export (hidden in a stored credential) — **verified with a one-off curl as the first implementation task** before any code depends on it.
3. Success = response contains `data.createPost.post.id` (per Workflow C's check; `MutationError` branch carries `message` otherwise).
4. On success: insert `posts` row (`status: 'queued'`, `buffer_update_id`, caption snapshot) → insert `post_images` rows (`sort_order` = request order) → update the selected ideas to `status: 'posted'`. This ordering means a mid-flight crash leaves a `posts` record before ideas flip; ideas flipping is the operation that removes the set from the postable pool.
5. On Buffer failure: insert `posts` row with `status: 'failed'` and the response body in `error`; ideas untouched — the set remains postable for retry.

Response: `{ post_id, buffer_update_id }` on success; `{ error }` with appropriate status otherwise.

## 4. Pure logic (`lib/athena/`, vitest-tested like Phases 1–2)

- `pickCaption(raw: string): string` — split on `||`, trim, drop empties, random pick; `''` if none.
- `selectAutoFill(postables, n)` — oldest-first by idea `created_at`, take first `n`; returns fewer if not enough (UI shows "x of N ready").
- `buildCreatePostMutation(channelId, urls: string[], caption)` — returns `{ query, variables }` for the Workflow C mutation with caption as a variable.
- `bufferTokenFor(account: 1 | 2)` — env token routing, throws if unset.

## 5. UI — `/post` page

Sidebar nav gains a Post entry. Server component fetches active categories, postable generations (joined with ideas), and post history; client component per category card:

- **Ready state:** "x of N ready". Below N: card is informational only.
- **At ≥ N:** auto-filled selection of N thumbnails (oldest first) shown in carousel order; click a selected thumbnail to remove it; click an image in the remaining-pool strip to append it; ◀/▶ buttons on each selected thumbnail to reorder (no drag-drop dependency).
- **Caption:** textarea pre-filled via `pickCaption` (client-side pick on load); freely editable per post.
- **Post button:** enabled only when exactly N selected; on click calls the API, shows success (with Buffer id) or the error inline; refreshes data after success.
- **History section:** table of `posts` rows — date, category, status, caption, `buffer_update_id`, error if failed.

No Realtime needed on this page; posting is synchronous.

## 6. Error handling

- All Buffer/API failures surface inline on the card and persist on the `posts` row (`failed` + `error`) — no silent failures.
- Failed posts leave ideas postable; retry is just posting again (creates a new `posts` row).
- Server re-validates everything client-side state claims (counts, postability, category match) — the UI is a convenience, not the guard.

## 7. Testing & acceptance

- Vitest units for all §4 functions (caption variants incl. empty/whitespace, auto-fill ordering/insufficient counts, mutation shape with variables, token routing incl. missing env).
- Auth-header verification curl before route implementation (§3.2).
- **Acceptance:** one real carousel queued via the UI, visible in the Buffer dashboard, `posts` row `queued` with Buffer id, ideas `posted` and gone from the postable pool. Then retire the n8n workflows.

## 8. Out of scope

- Share-now / custom-time scheduling (queue only).
- Engagement analytics (v2, per original spec).
- Deleting/canceling queued posts from the app (use Buffer's dashboard).
