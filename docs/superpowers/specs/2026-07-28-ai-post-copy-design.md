# AI-Written Post Copy — Design Spec

**Date:** 2026-07-28
**Status:** approved for planning
**Depends on:** structured carousels (`ideas.slides`), AI post-type wizard (merged `b6fbc9e`) — `DraftTurnOutput`, the config editor, and the BYOK generation path.

## 1. Summary

Today post text is `categories.post_caption`: static variants split by `||`, rotated at compose time by `pickCaption`, hand-edited in the composer. That is right for image-first platforms and wrong for LinkedIn/X, where the copy is the primary asset and the image supports it (the gap flagged in the 2026-07-27 meeting with Deirdre: the engine generates captions, not post copy).

This adds AI-written, per-post copy: the idea-generation call also writes `post_text` for categories that opt in, shaped by a platform preset plus a per-category copy guide plus brand voice. Copy is reviewed on idea cards, prefills the composer, and can be rewritten at post time with notes against the actual generated images.

**Decisions locked with Rayyan (2026-07-28):** draft at idea time AND regenerate at post time; per-category copy guide + brand voice as context; static captions coexist by mode; platform auto-derived from the Buffer channel with the guide as override; copy visible on idea cards, edited in the composer; rewrite sees the final images; single draft + rewrite (no variants); the wizard drafts the copy guide too.

## 2. Schema and the mode rule (migration 0011)

- `categories.caption_guide text not null default ''` — copy instructions for this category (length, structure, hashtags, CTA, voice nuances). **The mode is the guide's presence:** non-empty → AI copy per post; empty → today's rotating `post_caption`, byte-untouched. No separate toggle.
- `ideas.post_text text not null default ''` — the copy draft written at idea time.
- `categories.buffer_channel_service text not null default ''` — the Buffer channel's `service` (e.g. `linkedin`, `twitter`, `instagram`), captured **client-side when the channel is selected** in the config editor (the channel dropdown's data already carries `service`; write it alongside `buffer_channel_id` on save). No live Buffer call at generation time. Existing categories hold `''` until their next save; `''` maps to the generic platform preset.

`caption_guide` and `buffer_channel_service` join `CategoryFields` (manual editor reads/writes them); `post_text` is written by generation and the manual-idea dialog only.

## 3. Generation

- For categories with a non-empty `caption_guide`, the existing idea-generation call's output schema gains `post_text: string` per idea (structured output; categories in static mode return `""` and the value is ignored/stored empty). One call still writes the whole idea — slides and copy share one conception (same coherence principle as carousel text).
- The system prompt's copy section stacks, most general to most specific:
  1. **Platform preset** from `buffer_channel_service` — `linkedin`: long-form thought leadership, hook line first, short paragraphs/line breaks, no hashtag spam; `twitter`/`x`: tight, 280-character-aware; `instagram`: caption plus hashtags; anything else/empty: a generic caption preset.
  2. **Brand context** — `brand_profiles` voice/audience/avoid, already injected today.
  3. **The category's `caption_guide`** — overrides/extends the preset where they conflict.
- The AI filter call (call 2) already sees the full idea payload; `post_text` is included so weak copy can sink an idea.
- The manual-idea dialog gains an optional post-text textarea (hand-authored copy, no LLM).
- Token budget: `IDEA_GENERATION_MAX_TOKENS` (16000, SDK non-streaming ceiling) already covers worst-case slide batches; LinkedIn-length `post_text` per idea fits within it — the plan must sanity-check the arithmetic for a 20-idea batch and, if tight, lower the per-request idea cap for copy-mode categories rather than raising the token constant past the ceiling.

## 4. Ideas board

Pending-review cards show a collapsible copy preview when `post_text` is non-empty — approve/reject judges the whole post, copy first, image second. No editing on the card (editing lives in the composer; a dedicated review screen is the next project).

## 5. Composer and rewrite

- **Prefill rule:** when every selected image in `/post` belongs to the same idea and that idea has `post_text`, the caption box prefills with it; otherwise `pickCaption(category.post_caption)` exactly as today. (Phase B of the Post-menu project — `posts.idea_id`, carousel fill — will strengthen idea-scoped selection later; this rule is correct for both eras.)
- **Rewrite with notes:** a button beside the caption box calls a stateless endpoint — `POST /api/posts/rewrite-caption` with `{ categoryKey, ideaId?, note, imageUrls, currentText }` — which builds: platform preset + brand context + `caption_guide` + the idea's slides (when `ideaId` given) + the selected images as native vision blocks + the current text + the user's note, and returns the rewritten text. BYOK (`requireAnthropicKey`), 401/400/404/500 mapping per existing route conventions. **Nothing is persisted** — the returned text lands in composer state, and what the user posts goes to Buffer as now.

## 6. Wizard tie-in

- `caption_guide` joins `DraftTurnOutput` (described as: copy instructions for the platform this category posts to; empty string if the category should keep static rotating captions), `NormalizedDraft`, `draftColumns`, the live-draft panel, and the system prompt's field rules. It is a guide, not a URL/identity field, so it does not join the forbidden-fields list.
- The manual editor gets a `caption_guide` textarea near `post_caption`, with helper text: filled → AI writes each post's copy; empty → the rotating captions below are used.
- The channel dropdown's save path writes `buffer_channel_service` alongside `buffer_channel_id`.

## 7. Error handling

- Copy-mode idea generation failing structured-output validation: existing per-idea shape-drop path applies; an idea with malformed `post_text` (non-string) is dropped like a malformed slide array.
- Rewrite endpoint failures: inline error in the composer, current text untouched, retry by clicking again.
- Missing Anthropic key at rewrite: surface `requireAnthropicKey`'s existing message.

## 8. Testing

- Prompt-builder tests: platform presets keyed off `buffer_channel_service` values; stacking order (preset → brand → guide); copy section present only for copy-mode categories; mixed static/copy batches carry both instruction sets.
- Schema tests: `post_text` accepted/required in the ideas output shape; empty-string handling for static categories.
- Wizard schema/prompt tests extended for `caption_guide` (mirrors existing draft-category tests).
- Prefill rule unit test: same-idea selection → `post_text`; mixed-idea or no-copy → rotation.
- No live-LLM integration tests (consistent with the repo).

## 9. Out of scope

- Cross-posting one idea to multiple platforms with adapted copy (one category → one Buffer channel today).
- Copy variants (single draft + rewrite covers it).
- The dedicated review/edit screen (Post-menu project, next).
- Content pillars, pillar-to-channel mapping, persistent brand memory, `proof_points` (brand-analysis project).
- Backfilling `buffer_channel_service` for existing categories (self-heals on next save; `''` falls back to the generic preset).
