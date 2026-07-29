# Multi-Channel Posting — Design Spec (Post Menu, Phase 3 of 3)

**Date:** 2026-07-29
**Status:** approved for planning
**Depends on:** Buffer connections (merge `396fc10`) and the post composer (merge `4df8e1d`).
**Part of:** the Post Menu project — Phase 3, the last: 1) Buffer connections ✅, 2) ready-queue + composer ✅, 3) this.

## 1. Summary

The composer posts one idea to one channel — the category's. This makes it multi-channel with **adapted** copy per platform: the chip row selects any channels across all Buffer connections, each gets its own copy tab seeded by an adaptation call so LinkedIn long-form doesn't go out verbatim on X, and scheduling fans out to N Buffer updates recorded as N `posts` rows sharing one `post_group_id`.

**Decisions locked with Rayyan (2026-07-29):** best-effort fan-out with per-channel retry; one media strip truncated per platform; auto-adapt on chip-add that never overwrites hand edits; history grouped by `post_group_id`, expandable; posted-slide memory becomes per-channel; all channels selectable with the category's default preselected.

## 2. Schema (migration 0014)

Additive only — `posts.post_group_id` already exists and does the grouping.

- `posts.adapted_from_caption text not null default ''` — the base copy this channel's text was adapted from, so history can show what diverged. Empty when the channel's copy is the base copy unchanged.
- `posts.buffer_channel_service text not null default ''` — the service snapshotted at post time, so history renders the right platform icon even after a category is re-pointed.

No new tables. Existing rows keep working: both columns default to `''`.

## 3. Posted-slide memory becomes per-channel

`postedSlideIndexesByIdea` (in `lib/athena/carousel.ts`, joining `post_images → generations` with `posts.status`) gains a channel dimension — `posts.buffer_channel_id` is already on the joined row. It returns posted slides keyed by `(ideaId, channelId)`.

- **Composer:** a slot renders "already posted" only for the currently-focused channel tab. The same slide is fresh for a channel it hasn't gone to.
- **Queue:** `postedCount` counts a slide once it has gone to **any** channel (the queue answers "is there work left", not "where has this been").
- **Completeness:** an idea is marked `posted` when every declared slide has reached **at least one** channel. This keeps the queue clearing while leaving "send this to X next week" possible — the case a global rule would have blocked.

## 4. Channel chip row

Multi-select across every channel of every connection, grouped by connection name (reusing the `ChannelGroup` shape from Phase 1's `lib/settings/buffer.ts`). The category's own channel starts selected, so the existing single-channel flow stays one click. Each chip shows its service icon, the channel name, and — once posting starts — a per-channel status dot. Adding a chip creates its copy tab; removing one drops its tab, with a confirm when that tab's copy was hand-edited. At least one channel must be selected to post.

## 5. Copy tabs and adaptation

The copy region becomes tabbed: a **Base** tab (the idea's copy, as today) plus one tab per selected channel.

- Adding a channel fires `POST /api/posts/adapt-caption` — body `{ categoryKey, ideaId?, baseText, service, slides? }`, response `{ text }` — which builds its prompt from the base copy, the target platform's `platformPresetFor(service)` conventions, the category's `caption_guide`, and brand voice (the same layering the idea-time copy uses), returning copy rewritten for that platform. BYOK via `requireAnthropicKey`, stateless, persists nothing — same shape as the existing `/api/posts/rewrite-caption`.
- A tab whose text has been hand-edited is marked dirty and is **never** auto-re-adapted; re-adapting it requires an explicit click with a confirm.
- Editing the Base tab does not retroactively change already-filled channel tabs (they may have been edited); a "re-adapt all clean tabs" action handles the common case.
- Every tab keeps the existing rewrite-with-notes control, scoped to that tab.
- The preview rail follows the focused tab — that channel's copy in that channel's frame.

## 6. Media: one strip, truncated per platform

A single media strip for the whole post (unchanged from Phase 2, including swap/add and per-channel-aware posted marking from §3). A new pure helper `mediaForPlatform(imageUrls: string[], key: PlatformKey): string[]` in `lib/platform.ts` truncates per platform — X takes the first 4 (its mosaic limit), others pass through unchanged. **Both the preview and the outgoing Buffer payload use it**, so what a platform's frame shows is exactly what that platform receives. When truncation applies, the tab shows a one-line note ("X carries 4 images — the last N won't be sent").

## 7. Posting: best-effort fan-out

`POST /api/posts/create` changes shape: instead of deriving one channel from the category it takes

```
{ category_key, generation_ids, channels: [{ connectionId, channelId, service, caption }], scheduled_at? }
```

- Validation (auth, generation ownership, the anchor check, slide-count rules, past-date rejection) runs **once** before any Buffer call, exactly as today.
- One `post_group_id` is generated for the whole submission.
- Channels post **sequentially and independently**. A channel's failure never stops the others — a Buffer post cannot be un-posted, so best-effort is the only honest model.
- Each channel writes one `posts` row carrying that group id, its own `caption`, `status`, `error`, `buffer_channel_id`, `buffer_channel_service`, `adapted_from_caption`, plus the shared `idea_id`/`scheduled_at`. `post_images` rows attach per post row (so per-channel posted memory in §3 resolves correctly).
- Response: `{ postGroupId, results: [{ channelId, status, bufferUpdateId?, error? }] }`.
- The composer renders per-channel status on the chips and offers **Retry** for failed channels only — a retry re-submits just those channels into the **same** `post_group_id`.
- Completeness (§3) is evaluated after the fan-out, over the union of slides that actually succeeded somewhere.

## 8. History grouped by post_group_id

The recent-posts section groups rows by `post_group_id`: one row per group — category, idea concept, channel count, and a status summary ("2 queued · 1 failed") — expanding to per-channel rows with each channel's service icon, status, error, and copy. A single-channel post is a group of one and renders as it does today.

## 9. Error handling

- A channel whose connection is missing/revoked: that channel's row is `failed` with the connection error; others proceed.
- Adaptation call failure: inline error in that tab, the tab keeps whatever text it had, retry by clicking again.
- Zero channels selected: the Schedule button is disabled with a note.
- Partial success is reported as such — never "posted" or "failed" for the whole submission.

## 10. Testing

- `mediaForPlatform`: X truncates to 4, others pass through, empty and short arrays unchanged.
- Per-channel posted memory: a slide posted to channel A is posted for A and fresh for B; the queue counts it once; completeness fires when every slide has reached at least one channel.
- Fan-out result shaping: a pure helper mapping per-channel outcomes to the response summary and to the "N queued · M failed" string, covering all-success, all-fail, and mixed.
- History grouping: a pure helper grouping post rows into groups with their status summary.
- The adaptation prompt builder: platform preset present, caption guide layered over it, base copy included.
- No live-LLM or live-Buffer integration tests (consistent with the repo).

## 11. Out of scope

- Per-channel media selection (one strip, §6).
- Per-channel scheduling times — one scheduling choice applies to every channel in the submission.
- Posting to platforms with no Buffer connection, and auto-publishing/opt-out scheduling.
- Editing or deleting an already-scheduled Buffer post from this app.
