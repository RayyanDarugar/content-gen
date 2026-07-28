# AI-Assisted Post-Type Authoring — Design Spec

**Date:** 2026-07-27
**Status:** approved for planning
**Depends on:** structured carousels (merged to `main`, 2026-07-27) — `post_type`, `role_guides`, and the existing `CategoryEditor`.

## 1. Summary

Today, defining a category means hand-writing a style guide, output format, and (for narrative posts) per-role treatment from a blank page. This is the "next spec" flagged in `docs/superpowers/plans/2026-07-27-structured-carousels-followups.md` §5: a conversational drafting flow that produces the same `categories` fields the manual editor already renders, so the assist lane fills the manual lane's objects rather than getting its own.

Two ways to start a session — **describe it** (plain English) or **show it** (upload a screenshot of a post whose structure you like) — converge into one multi-turn conversation. Every turn returns a full structured draft; the user can ask for a real generated sample before ever touching `active`; exiting just means going to the existing editor to do final hand-edits or flip the category live.

**Key decision: no schema changes.** Every field the wizard produces already exists on `categories`. The optional test-run preview reuses existing pure generation functions and writes nothing to `ideas`/`generations`.

## 2. Relationship to other planned work

This is the *format/series* half of the "assist lane" phase from the content-engine product-direction brainstorm; brand extraction (an onboarding wizard analyzing brand voice/proof points) is the other half and is separate, not a dependency. This spec reads `brand_profiles` as context the same way `generateIdeas` already does, so it works with today's brand fields and improves for free as brand extraction adds richer ones later. `style_ref_url` currently lives on `categories`; it's slated to move to brand-level in a later object-model split, independent of this spec — the upload here targets today's actual schema.

## 3. Conversation mechanics

- A drafting session is a client-held array of `{role, content}` conversation turns, not a persisted chat thread — no new table, no session/resume infrastructure.
- Each turn is sent as real multi-turn Anthropic `messages`, using the caller's own key via `requireAnthropicKey(userId)` (same BYOK pattern as `generateIdeas`).
- Every assistant turn returns one structured object via `zodOutputFormat` (same mechanism as `IdeasOutput`):
  ```
  {
    assistant_message: string,   // renders as the chat reply
    name: string,
    style_guide: string,
    output_format: string,
    post_type: "independent" | "narrative",
    role_guides: Partial<Record<"hook"|"beat"|"payoff"|"single", string>>,
    images_per_carousel: number,
    aspect_ratio: string,
  }
  ```
  `assistant_message` renders in the chat; the remaining fields render in a read-only live-draft panel alongside it. There is no free-text assistant output outside this schema.
- A screenshot (format example) attaches as an image content block on whichever turn includes it — Claude reads it natively; no separate vision model or pipeline.
- The system prompt injects the user's `brand_profiles` row as context on every turn, matching `generateIdeas`'s existing brand-context construction.
- **Screenshot instruction constraint:** the prompt must explicitly direct the model to extract *structure and copy pattern* from a screenshot (panel count, what each role does, pacing, caption pattern) and never palette, photography style, or other visual-style signals — visuals come from the user's own brand reference, never from a cloned example. This is a hard requirement on the prompt wording, not a suggestion to the model.

## 4. Persistence: continuous upsert

- Turn 1 creates the `categories` row immediately with `active: false` (reusing `createCategory`'s validation, via `slugify(name)` for `key`; if the model hasn't produced a stable name yet, default to a placeholder and let a later turn rename it).
- Turn 2+ update that same row (reusing `updateCategory`'s validation).
- There is no separate "commit" step — the row is always in sync with the latest turn. Exiting the wizard just navigates to `/config` with that category open in the existing `CategoryEditor`.
- Abandoning mid-conversation leaves an ordinary inactive category, visible and deletable in the existing category list exactly like a hand-started one. No cleanup job for stale drafts in this spec (YAGNI — nothing currently cleans up abandoned hand-authored categories either).

### Revising an existing category

- An existing category gets a "Revise with AI" action (next to Delete) that seeds turn 1 with its current fields as context instead of starting blank.
- This path never creates a new row — every turn updates the existing category by id, same as the continuous-upsert mechanic above.

## 5. Entry points and input slots

- **New category:** a "Draft with AI" action alongside today's blank "Add a new category" form in `CategoryManager`.
- **Existing category:** "Revise with AI" next to Delete.
- At the start of a session, three clearly separated input slots:
  1. **Description** (text, optional) — plain English.
  2. **Format example** (image, optional) — "show it" screenshot; structure/copy only, per §3's constraint.
  3. **Brand visual reference** (image, optional) — the actual `style_ref_url`. If skipped, the wizard shows a non-blocking note that preview and generation will look generic without one (matches this repo's own tested finding that the reference image, not prose, controls visual output).
- At least one of description or format example is required to start; brand visual reference is always optional (can be added later in the editor, same as today).

## 6. Test-run preview

Verified against the actual code: `uploadStyleRef`, `buildSlidePrompt`, `createKieTask`, and `getKieRecord` (`lib/athena/kie.ts`, `lib/athena/image-prompt.ts`) are pure functions with no database reads or writes.

- "Test this" reuses the existing idea-generation prompt path to produce exactly one sample idea against the current (already-persisted) draft category, then submits it through the same four functions used in production — **anchor slide only by default**.
- For narrative drafts, an explicit "generate full test carousel" upgrade fans out the remaining slides through the same chained-reference path production uses (`buildSlidePrompt(..., chained: true)` against `[styleUrl, anchorImageUrl]`), since that's the only path that actually exercises `role_guides` and is the one open design question from the carousels work.
- The client polls a thin server action wrapping `getKieRecord(kieKey, taskId)` by task id until the state resolves; no database row is created for the preview at any point. Nothing here touches `ideas`, `generations`, the orphan sweep, the ideas board, or the gallery.
- A failed preview (Kie has been observed to time out on first attempt) shows inline with a "Retry test" button. It never blocks exiting the wizard — production's own retry path applies once the category is live regardless of preview outcome.

## 7. Error handling

- Missing Anthropic or Kie key: surface `requireAnthropicKey`/`requireKieKey`'s existing error text, pointing back to Config.
- LLM call failure or a turn that fails schema validation: inline error in the chat; client-held conversation state is untouched, so the user can just resend.
- Preview generation failure: see §6.
- Upload failures (screenshot or brand reference): same handling `uploadStyleRefImage` already uses.

## 8. Testing

- Unit tests for the new prompt builder and schema: shape validation, brand-context injection, and specifically the screenshot instruction steering away from palette/visual-style language — mirrors the style of `tests/prompts.test.ts`.
- Preview-path tests against the pure `kie.ts`/`image-prompt.ts` functions with a mocked `fetch`, consistent with how generation logic is already tested.
- No integration test against live Kie or Anthropic.

## 9. Out of scope

- Persisted or resumable chat threads (a general chat surface was already deferred in the product-direction brainstorm).
- Scoped correction directives that propagate across ideas/series/brand — that's the later "compounding layer" in the product-direction sequencing, not this spec.
- Any cleanup job for abandoned drafts.
- Video.
- Brand extraction / onboarding wizard (separate, sibling work — see §2).

## 10. Addendum (2026-07-28): cementing test runs as per-role reference images

Decided with Rayyan after the branch's final review. A successful test run can be promoted to become the category's permanent per-role reference images — the initial brand reference inspires the category; once it produces a good post, that output cements it. Because this repo's measured finding is that the reference image beats art-direction prose, a promoted hook ref *carries* the hook's treatment (tag, strike-through) and a promoted payoff ref carries its clean look — attacking §1 of the carousels followups (role_guides prose vs. anchor image) with images instead of prose.

**Schema:** `categories.role_ref_urls` jsonb (`{hook?, beat?, payoff?, single?}` — durable Cloudinary URLs), defaulting `{}`. Migration 0010. `style_ref_url` remains the fallback for any role without a ref.

**Resolution rule (one helper, used by every first-assembly site):** `resolveRoleRef(category, role)` → `role_ref_urls[role] ?? style_ref_url`. Role ref *replaces* the brand style ref (stays in Kie's tested 2-ref regime): anchor gets `[roleRef(hook|single)]`; fanned slides get `[roleRef(role), anchorImage]`. Kie uploads of role refs use fileName `<CATEGORY_KEY>_<role>.jpg` to avoid clobbering the brand ref copy. Rows still store what they used in `generations.kie_style_url`, so all retry paths replay the stored value unchanged.

**Promotion (wizard test runs only, this iteration):** after a test run, the preview pane lets the user pick one generated image per role (click-to-choose; multiple beats → user picks the beat). "Cement as reference images" POSTs the picked Kie result URLs; the server re-uploads each to Cloudinary (Kie URLs are ephemeral) and merges into `role_ref_urls`. The manual editor displays existing role refs with per-role clear buttons (correction surface); manual saves never write `role_ref_urls` (`CategoryFields` deliberately excludes it), so only promotion writes it and only clear removes it. The drafting LLM schema continues to exclude all URL fields.

**Deferred:** promoting from the gallery (real posts), multiple refs per role, 3-ref Kie calls.
