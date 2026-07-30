# Auto-Generated Style Reference — Design Spec

**Date:** 2026-07-30
**Status:** approved for planning
**Depends on:** brand design tokens (merge `16b314d`, colors/fonts/visual_notes), the existing Kie image pipeline (`lib/athena/kie.ts`), and the `promote-refs` re-hosting precedent (`app/api/categories/draft/promote-refs/route.ts`).

## 1. Summary

Clicking "Test this draft" on a category with no reference image currently dead-ends with a message telling the user to upload one and re-open the wizard. This closes that gap generally, for any category — suggested or manually built — that reaches Test Run without a reference: the wizard generates a starter reference image from the brand's own scraped colors/fonts/visual_notes (falling back to business description/voice/audience when those are thin), re-hosts it permanently, saves it as the category's real `style_ref_url`, and proceeds straight into the normal test-run flow — one continuous "Generating…" state, no extra click, no leaving the wizard.

Once saved, it's replaceable exactly the way any reference image is today (upload a new one in Config's editor), and additionally via a **Regenerate with notes** control available anywhere the current reference is shown — usable on any reference regardless of how it got there, matching the fact that a manual upload already has no confirmation step before being overwritten.

**Why now:** this was found while diagnosing why Test Run silently failed for a suggestion-derived category. The underlying `hasStyleRef` gate long predates this feature (from the Phase A carousel work), but nothing in the suggested-post-types wizard flow ever offered a way to satisfy it — the upload control lives only on the wizard's pre-conversation start screen, which a seeded suggestion conversation skips entirely.

## 2. Trigger and UI flow

`preview-pane.tsx`'s dead-end message is removed. "Test this draft" is always clickable whenever the Kie key is present. `startTest()` checks the category's current `style_ref_url`:

- **Empty:** runs the placeholder-generation phase first (staged message: "Generating a starter reference image for your brand…"), then falls straight into the existing test-run flow ("Generating your sample post…") using the newly populated reference. One continuous progress state.
- **Already set:** behaves exactly as today, unchanged.

**Regenerate.** Wherever a reference image is currently shown — inline right after it's generated in the wizard, or later in Config's category editor — a small control appears beside it: an optional one-line notes field + "Regenerate" button. Reruns generation with the same brand-grounded prompt plus the note appended, re-hosts the result, and overwrites `style_ref_url`. Works on any current reference image regardless of origin (generated or manually uploaded) — no confirmation dialog, consistent with how a manual re-upload already overwrites with no confirmation today.

## 3. The prompt

`buildStyleRefPrompt(brand: BrandContext, notes?: string): string` — a pure, deterministic function, no LLM call:

- **Design tokens present** (`colors`, `fonts`, or `visual_notes` non-empty): cites them explicitly — an abstract style reference showcasing that palette, that typographic feel, those visual notes.
- **Nothing scraped:** falls back to `business_description` / `voice` / `audience` for a generic-but-on-topic prompt.
- **Both branches** carry a hard, repeated constraint: **no logo, no invented product photography, no text overlays** — purely a color/texture/mood board. This is not optional framing — a prior Kie test (2026-07-27, on record) demonstrated the generative route reliably fails at inventing a believable mark, so the prompt must never attempt one.
- **`notes`** (the regenerate case), when present, is appended as an explicit "Additional direction for this regeneration: {notes}" instruction.

## 4. The Kie call and the endpoint

One new function in `lib/athena/kie.ts`:

```ts
createTextToImageKieTask(apiKey: string, prompt: string, aspectRatio: string): Promise<string>
```

Mirrors `createKieTask`'s shape (same headers, same task-creation response parsing) but calls `model: "gpt-image-2-text-to-image"` with `input: { prompt, aspect_ratio }` — no `input_urls`, since this is pure text-to-image with no seed image. `aspectRatio` is always the category's own `aspect_ratio` — the same value every other Kie call for that category already uses — so the placeholder's shape matches how the category actually posts, not an arbitrary default.

One new route, `POST /api/categories/draft/style-ref`, two phases mirroring the existing `POST /api/categories/draft/preview`'s own shape:

- **`{ categoryId, phase: "generate", notes?: string }`** — loads the category and brand profile, builds the prompt via `buildStyleRefPrompt(brand, notes)`, calls `createTextToImageKieTask`, returns `{ taskId }`.
- **`{ categoryId, phase: "finalize", imageUrl: string }`** — re-hosts the (ephemeral) Kie result on Cloudinary, reusing `uploadImageToCloudinary` and the same HTTPS/size-cap validation `promote-refs` already applies (15MB, `https:` only), writes the result straight to `categories.style_ref_url` (RLS-scoped via `requireUser`/`createServerSupabase`, no explicit `user_id` filter needed), returns `{ styleRefUrl }`.

**No new polling endpoint.** The `generate` phase's `taskId` is polled via the **existing** `GET /api/categories/draft/preview?taskId=...` — that handler is already task-agnostic (`getKieRecord` doesn't care what kind of Kie task it's asking about), so it needs no changes.

**Why a direct write, not the chat-turn path:** a manual reference upload today goes through `pendingStyleRef`, only persisted when the next chat turn is sent — because it happens mid-conversation. Test Run and Regenerate both operate on an already-persisted category outside any conversation turn (`categoryId` must already exist for `PreviewPane` to render at all), so a direct update is the correct shape here, following the same precedent `promote-refs` already set for a similar out-of-band write.

**Client wiring:** `PreviewPane` gains an `onStyleRefGenerated(url: string)` callback prop. After a successful `finalize`, the parent `DraftWizard` updates its own `brandRefUrl` state so the live-draft panel and any subsequent Test Run correctly reflect the new reference without a page reload — `DraftWizard` owns that state today and computes `hasStyleRef` from it.

## 5. Fallback and error handling

**Fallback:** a brand with no usable design tokens (empty extraction, or a site the token parser can't read — e.g. a Tailwind v4 site using `oklch()`) still gets a placeholder, built from whatever text fields exist. Test Run never blocks on a thin brand profile, consistent with suggestions themselves already working on brand knowledge alone.

**Errors:** a failed `generate` or `finalize` call (bad URL, oversized download, Cloudinary failure, Kie failure) surfaces through the exact same `error` state Test Run already has, with the button re-enabled to retry. No silent fallback to a broken or blank reference.

## 6. Testing

Pure-function only, consistent with this repo's convention — no live-Kie tests anywhere in the codebase, and this doesn't change that:

- `buildStyleRefPrompt`: cites real colors/fonts/visual_notes when present; falls back to business fields when none of the three are set; appends `notes` when given, omits the line when not; the no-logo/no-invented-product constraint is present in every branch (design-tokens path and fallback path alike).

## 7. Out of scope

- **Per-role placeholders** (hook/beat/payoff/single). Only the single base `style_ref_url` is auto-generated. Per-role reference images still only ever come from cementing real test-run output through the existing "Cement as reference images" flow (`promote-refs`).
- **Origin tracking** (whether the current reference was generated or uploaded) — considered and explicitly declined; Regenerate works on any current reference regardless of how it got there.
- **A confirmation dialog before Regenerate overwrites** — matches today's manual-upload behavior, which has none either.
