# Suggested Post Types — Design Spec

**Date:** 2026-07-29
**Status:** approved for planning
**Depends on:** the AI post-type wizard (merge `b6fbc9e`) and brand extraction (merge `ec0a7a4`) — this reuses both and adds no new drafting surface.
**Sequenced after:** brand design-token extraction (colors, fonts, visual notes scraped from the site). Decided 2026-07-29: that lands first, because a suggested `style_guide` written without the brand's actual palette and type says "clean modern palette" — the generic output this feature exists to avoid. Once it exists, the suggestion prompt must cite the brand's real colors and fonts in the `style_guide` it drafts, treating them as the default a post type may deliberately override.

## 1. Summary

A user reaching the post-type step can either build their own or ask for one. The system proposes a post type grounded in their brand — config plus a fully-worked sample post plus a rationale — and they iterate on it exactly as they would iterate on their own. Available in the onboarding wizard and in `/config/draft` generally.

**Why now, not earlier:** suggestion quality is entirely a function of how well the system knows the brand. Before brand extraction it knew tone and audience, which would have produced the generic suggestions that kill trust on first contact. It now knows `proof_points` and `standing`.

**Decisions locked with Rayyan (2026-07-29):** the light version — suggestions come from the brand profile plus the model's own knowledge, with **no format library** (that is project 2, deliberately deferred); a sample post with real copy shown immediately, real images on demand via the wizard's existing test-run; one suggestion at a time with re-roll; two entry points, one implementation.

## 2. The core move: a suggestion is an opening turn, not a new surface

`/config/draft?suggest=1` loads the existing wizard, calls the suggestion endpoint on mount, and seeds the conversation with the proposal as its **first assistant turn**. From there every existing mechanism takes over unchanged: the live draft panel, rewrite-with-notes, "Test this draft", continuous upsert, the same `categories` object.

This is what makes iterating on a suggestion identical to iterating on your own — the stated goal — and it means there is no second drafting flow to build or maintain.

It also satisfies the standing architectural rule that **the suggestion lane drafts into the manual lane's objects and never gets its own tables.** No schema change; no migration.

## 3. `POST /api/categories/suggest`

Request `{ excludeConcepts?: string[] }` → response `{ rationale: string, draft: DraftTurnOutput, sample: SamplePost }`, one structured-output call, BYOK via `requireAnthropicKey`, persisting nothing.

- **`draft`** reuses the wizard's existing `DraftTurnOutput` shape exactly (`name`, `style_guide`, `output_format`, `post_type`, `role_guides`, `caption_guide`, `images_per_carousel`, `aspect_ratio`, `assistant_message`), so it drops into the live panel with zero adaptation.
- **`sample`** is the fully-worked example: `concept`, `slides[{role, text, visual}]` matching the existing `Slide` shape, and `caption`.
- **`rationale`** is two sentences — why the structure works, and why it fits this brand, citing an actual proof point.
- **`excludeConcepts`** carries the concepts already shown this session so "suggest a different one" produces a genuinely different format rather than a rephrase.

Brand context comes from the shared `brandBlock`, so proof points and standing are already in scope.

## 4. The honesty constraint

Without a format library the model **cannot truthfully claim currency** — its knowledge is frozen at training cutoff and it will invent trends confidently if allowed to. The prompt therefore:

- **Forbids currency claims.** No "this is trending right now", no invented platform statistics, no named accounts it cannot verify.
- **Requires the rationale to be craft plus fit.** Craft: why the structure works mechanically ("a myth-bust opens a curiosity gap the payoff closes, which is why it survives platform churn"). Fit: why it suits *this* brand, naming a real proof point or standing entry from the profile.
- **Requires the sample to use the brand's actual material.** A sample built on invented claims is worse than no sample; it teaches the user the system doesn't know them.

This is the honest version of "here's why this lands" given the no-library constraint, and it is what project 2's format library will later *upgrade* rather than replace.

## 5. Persistence deviates from the wizard, deliberately

The wizard upserts an inactive category on turn 1. A suggestion does **not** persist until the user engages with it — otherwise every re-roll litters Config with abandoned categories. The suggestion is held client-side; the first real turn (accepting, or editing anything) persists it through the existing draft route, after which it is an ordinary wizard conversation.

Re-rolling replaces the held suggestion and never creates a row.

## 6. Surfaces

- **Onboarding step 2** offers "Build my own" (existing link) and "Suggest one for me".
- **Config** gets "✨ Suggest one" beside the existing "✨ Draft with AI".
- Both link to `/config/draft?suggest=1`. One implementation.

## 7. Error handling

- Suggestion call failure: inline error in the wizard with a retry, falling back to the ordinary blank drafting conversation so the user is never stuck. Upstream LLM errors surface through `friendlyLlmError` (merge `7566247`) like every other LLM surface.
- **No brand profile, or one with an empty `business_name`:** the suggest entry points are disabled with a note pointing at brand setup — a suggestion built on nothing is the generic output this feature exists to avoid.
- A malformed structured output (missing `sample`, wrong slide shape) is treated as a failed suggestion and retried rather than partially rendered.

## 8. Testing

- The suggestion prompt builder: brand material present; currency claims explicitly forbidden; rationale required to cite brand material; `excludeConcepts` rendered when supplied and omitted when empty.
- The sample's slide array validated against the existing `validateSlideShape` rules for its `post_type` (narrative → hook/beats/payoff; independent → one `single` slide), so a malformed sample is caught rather than rendered.
- Seeding logic: a suggestion response maps to a first assistant turn in the wizard's existing `DraftTurn` shape.
- No live-LLM tests, consistent with the repo.

## 9. Out of scope

- The format library, screenshot-to-format, and the Brand/Format/Series split (project 2). **This is designed so the library later replaces only *where the format comes from*, leaving the endpoint's response shape, the seeding mechanism, and the whole wizard surface untouched.**
- Proactive or scheduled series proposals (needs the cadence model — project 3).
- Multiple simultaneous suggestions and any comparison UI.
- Suggesting ideas *within* an existing post type; this suggests the post type itself.
