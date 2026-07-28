# Post Composer — Design Spec (Post Menu, Phase 2 of 3)

**Date:** 2026-07-28
**Status:** approved for planning
**Depends on:** Buffer connections (merge `396fc10`) — `categories.buffer_connection_id`/`buffer_channel_service`, `posts.post_group_id`/`buffer_channel_id`; AI post copy (merge `2ecb943`) — `ideas.post_text`, the rewrite endpoint.
**Part of:** the Post Menu project — Phase 2 (ready-queue + composer) of: 1) Buffer connections ✅, 2) this, 3) multi-channel adapted copy.

## 1. Summary

Today `/post` is pool-centric: one composer per category, an unordered pool of images, auto-fill that deliberately skips carousels. This replaces it with the post-centric model from Buffer's Create Post: a queue of postable ideas, and a composer for one post at a time — copy centerpiece, media strip autogrouped in slide order with per-slot swap, and a live per-platform preview.

It also absorbs the deferred "Phase B" list from `docs/superpowers/plans/2026-07-27-structured-carousels-followups.md` §2 (carousel fill, slide-aware count validation, `posts.idea_id`) and two Phase 1 punch-list items.

**Decisions locked with Rayyan (2026-07-28):** one cross-category queue; complete AND partial ideas both listed (partial badged); freeform pool-picking lives inside the composer as swap/add rather than a separate mode; previews are faithful (icons, action rails, real layout) built on a shared skeleton, not pixel-parity mocks; TikTok, Instagram, LinkedIn, and X templates plus a generic fallback.

## 2. Migration 0013

- `posts.scheduled_at timestamptz` (nullable) — set when the user picks a custom time; null means it went to Buffer's queue.
- `alter table buffer_connections add constraint buffer_connections_user_label_unique unique (user_id, label)` — Phase 1 punch-list item; ambiguous optgroup labels otherwise, and any future join on label would fan out. **The migration must dedupe first** (append ` (2)`, ` (3)` to later duplicates per user) so it can't fail on existing data.
- `set_updated_at` trigger on `buffer_connections`, matching the convention in migrations 0001/0006 (Phase 1 punch-list item).

## 3. Shared slide resolution

`findSupersededGenerationIds` in `lib/athena/carousel.ts` already computes the valid generation per `(idea, slide)` under the idea's current anchor. That logic is factored into an exported `resolveValidSlides(idea, generations): { slideIndex: number; generation: Generation | null }[]` returning one entry per declared slide (null = not yet generated), with `findSupersededGenerationIds` reimplemented over it so the queue, the composer, and `posts/create`'s validation cannot disagree. Pure, unit-tested; this is the correctness backbone of the whole phase.

## 4. The queue (`/post`)

- One cross-category list of ideas having at least one succeeded slide, newest-ready first. Each row: first available slide's thumbnail, category badge (`lib/category-colors.ts`), concept, a copy snippet when `post_text` is set, and a readiness badge — `5/5 ready` or `3/5 slides ready`.
- Partial ideas are listed, not hidden: a stalled fan-out must be visible rather than silently absent (today's auto-fill hides exactly this case).
- Already-posted ideas drop off the queue. Recent posts stay listed below, as today.
- Rows link to `/post/[ideaId]`.

## 5. The composer (`/post/[ideaId]`)

Three regions, mirroring Buffer's Create Post:

- **Channel chip** — the category's channel with its service icon and name, single-select in this phase (Phase 3 turns the row multi-select). A category whose channel is missing from its connection's live channel list, or has no connection, shows an inline warning linking to Config instead of a chip, and posting is disabled.
- **Copy centerpiece** — a large textarea prefilled from `ideas.post_text` (falling back to `pickCaption(category.post_caption)` when empty), with the existing rewrite-with-notes control moved in beside it. A character counter appears when the platform has a limit (X).
- **Media strip** — slots in `slide_index` order from `resolveValidSlides`. Each filled slot: thumbnail, slide role label, and a swap menu listing that slide's *other* succeeded generations first (newest first), then the rest of the category's postable pool. Each empty slot (slide not yet generated) renders as "waiting on generation" and is skipped when posting. An `+ add` slot appends any pool image; slots reorder by drag; any slot can be removed.
- **Right rail** — the live platform preview (§6), reflecting the current copy and current slots.
- **Footer** — "Next available" (default) or a datetime picker, then Schedule.

## 6. Preview components

`components/preview/`: a shared `PhoneFrame` (aspect ratio from `category.aspect_ratio`, safe-area padding, overflow handling) plus `TikTokPreview`, `InstagramPreview`, `LinkedInPreview`, `XPreview`, and `GenericPreview`. Selection is by normalized service string, reusing the same normalization the copy layer uses (`platformPresetFor`'s `trim().toLowerCase()` with both `twitter` and `x` mapping to X) via a shared `normalizeService(service): "tiktok" | "instagram" | "linkedin" | "x" | "generic"` helper so copy and preview can never disagree about what platform a category is.

Each template renders the real slide images and the live caption with that platform's conventions:
- **TikTok** — full-bleed slide, Following/For You header, right action rail, bottom username + caption, `1/N` pager.
- **Instagram** — top bar (avatar, username), square-ish image, action row, caption prefixed by username with `... more` truncation, dot pager for multi-slide.
- **LinkedIn** — avatar, name, headline line, copy above the image with `…see more` truncation at roughly 3 lines, reaction bar.
- **X** — avatar, name + handle, copy with the 280-character boundary indicated, and **a 2×2 mosaic for multi-image posts rather than a carousel**, because X does not carry carousels — the preview should surface that a 5-slide idea becomes a 4-image mosaic there.
- **Generic** — plain frame, image(s), caption.

Icons come from `lucide-react` (already a dependency). Avatar/username come from the Buffer channel (`displayName`/`avatar`), falling back to the brand profile's business name.

## 7. Posting

- `buildCreatePostMutation` gains an optional scheduled time: absent → today's `schedulingType: automatic, mode: addToQueue` unchanged; present → Buffer's custom-time variant. **Buffer's exact GraphQL shape for a scheduled post is unverified.** The implementer must confirm it against Buffer's API before writing the mutation; if it cannot be confirmed, ship queue-only with the picker disabled and a visible note, rather than guessing a mutation shape.
- `posts/create` validation becomes slide-aware: the expected count is the idea's own resolved slide count, not `category.images_per_carousel`.
- Inserted `posts` rows now carry `idea_id`, `buffer_channel_id`, and `scheduled_at`.
- The idea is marked `posted` **only when every declared slide was included**; a partial post leaves it postable so a late-succeeding slide is never stranded (the deferred bug in the carousels punch list).

## 8. Error handling

- Missing connection/channel, or channel absent from the live list: composer warning, posting disabled (§5).
- Buffer post failure: the existing failed-`posts`-row path, surfaced inline in the composer with the message.
- An idea whose slides all vanish (e.g. every generation superseded) while the composer is open: posting returns the existing superseded-generation 400; the composer surfaces it and a refresh re-resolves.
- Preview rendering never blocks posting — an image that fails to load shows a placeholder.

## 9. Testing

- `resolveValidSlides` (§3): complete carousel, partial, retried slide, re-anchored carousel with stale siblings, single-slide idea — plus `findSupersededGenerationIds`' existing tests continuing to pass over the refactor.
- Queue row derivation (readiness counts, thumbnail choice, ordering) as a pure function.
- `normalizeService` mapping including `twitter`/`x`/case variants.
- Slide-aware count validation and the mark-posted-only-when-complete rule.
- Preview components are visual; no snapshot tests (they'd ossify styling) — verification is the build plus a human look.

## 10. Out of scope

- Multi-channel selection and per-channel adapted copy (Phase 3; the chip row and copy region are structured so it slots in without rework).
- Auto-publishing / opt-out scheduling, analytics, per-platform copy limits enforcement beyond a counter.
- Editing an already-scheduled Buffer post from this app.
