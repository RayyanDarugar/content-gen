# Brand Depth, Extraction, and Onboarding — Design Spec

**Date:** 2026-07-29
**Status:** approved for planning
**Depends on:** the AI post-type wizard (merge `b6fbc9e`) — onboarding step 2 hands off to it unchanged.

## 1. Summary

`brand_profiles` is five hand-typed fields giving the model tone and audience but no *material*, which is why generic output is the failure mode. This adds the material — `proof_points` and `standing` — plus an extraction flow that drafts the whole profile from a website, uploaded documents, and/or a conversation, and a first-run onboarding path that chains brand setup into the existing post-type wizard and a first generation.

**Decomposition decided with Rayyan (2026-07-29):** this is project 1 of three. The Brand/Format/Series object-model split (plus the format library and screenshot-to-format) is project 2; content pillars, pillar-to-channel mapping, and cadence are project 3. This project deliberately renames nothing, so it lands without touching the four projects already built on `categories`.

**Decisions locked:** extraction reads URL + documents + conversation (stacking, not competing); `proof_points`/`standing` are structured lists rather than prose; extraction drafts into the form for approval and never silently overwrites; onboarding is a dismissible first-run banner leading to a 3-step wizard; all proof points reach generation as material to draw on.

## 2. Schema (migration 0015)

- `brand_profiles.proof_points jsonb not null default '[]'::jsonb` — array of short claim strings, each a concrete piece of material (e.g. `"5,000 students raised scores 120+ points"`).
- `brand_profiles.standing jsonb not null default '[]'::jsonb` — array of topics the brand can credibly speak on.

Both default empty, so every existing profile keeps working with no backfill. **`style_ref_url` stays on `categories`** — moving it to brand level belongs with the object-model split and would disturb the role-ref cementing work for no benefit here.

`BrandProfile` in `lib/types.ts` gains both as `string[]`. `BrandContext` (`lib/athena/prompts.ts`) gains them too, since it is the shape every prompt builder consumes.

## 3. Extraction endpoint

`POST /api/brand/extract` — `{ url?: string, documentUrls?: string[], turns?: {role, text}[] }` → the full structured draft `{ business_name, business_description, audience, voice, avoid, proof_points: string[], standing: string[] }` via `zodOutputFormat`. BYOK (`requireAnthropicKey`), stateless, persists nothing. At least one input is required.

Inputs stack rather than compete:
- **URL** — fetched server-side, readable text extracted (strip scripts/styles/nav chrome), truncated to a sane budget before it reaches the model.
- **Documents** — Cloudinary URLs from the existing upload action, passed as native attachments. Claude reads PDFs directly, which matters because pitch decks and one-pagers are the richest proof-point source.
- **Conversation** — real multi-turn `messages`, so the user corrects the draft in place the way the post-type wizard works.

**Prompt intent, which is the whole point of the feature:** extract *material*, not adjectives. Pull concrete claims with numbers, names, and specifics; never invent a claim the source doesn't support; list `standing` only for topics the source actually evidences. An empty `proof_points` array is a correct answer for a thin source — a fabricated one is not.

**URL fetching is hardened up front**, applying the lesson from the promote-refs endpoint rather than repeating it: https-only; redirects validated per hop (`redirect: "manual"`); private/loopback/link-local hosts rejected; `text/html` (or text/*) content-type required; response streamed with an abort past a size cap rather than buffered whole.

## 4. Brand form as a review surface

`app/(app)/config/brand-section.tsx` (37 lines today) grows into:
- The five existing fields, unchanged.
- **List editors** for proof points and standing: each item editable in place, add and remove per item, reorderable is not needed.
- A **"Draft with AI"** entry opening the extraction flow (URL field, document upload, and a chat box — the three inputs in one panel).

Extraction fills the form; the user saves when it looks right. **Re-running extraction on a populated profile shows what changed** — a per-field indication of proposed vs current, with the user accepting per field — rather than replacing hand-written values wholesale. This is the same never-clobber-hand-edits rule the post-type wizard follows.

`saveBrandProfile` extends to persist both arrays, validating that each is an array of non-empty strings.

## 5. Onboarding

An empty brand profile (no `business_name`) surfaces a dismissible **"Set up your brand"** card on the dashboard, linking to `/onboarding`.

Three steps, each reading real state so nothing is redone:
1. **Brand** — the extraction panel from §4; completes when a profile with a `business_name` is saved.
2. **First post type** — hands off to the **existing** `/config/draft` wizard with a return link. No new drafting code.
3. **First ideas** — triggers a generation for the new category and lands the user on the ideas board.

The wizard is dismissible, resumable, and re-enterable from Config. A user who already has a brand or an active category sees those steps already complete and continues from the first incomplete one.

## 6. Generation gets material

`brandBlock` (`lib/athena/prompts.ts`) — already shared by the idea prompt, the filter, the caption rewrite, the caption adaptation, and the post-type wizard — gains the proof points and standing. Because it is shared, one change improves every LLM surface at once.

Added instruction, alongside the existing brand context: ground ideas in this specific material rather than generic claims; prefer a concrete proof point over an abstract benefit; and decline angles the brand has no standing for. Empty arrays render nothing, so a profile without them behaves exactly as today.

## 7. Error handling

- URL fetch failures (unreachable, blocked host, wrong content type, too large): a clear per-input inline error; extraction still runs on whatever other inputs were supplied.
- Document read failure: same, named per document.
- No usable input, or the model returning an unparseable draft: inline error, form untouched, retry by clicking again.
- Missing Anthropic key: the existing `requireAnthropicKey` message, pointing at Config.

## 8. Testing

- `brandBlock` with and without proof points/standing: the material appears when present; the output is byte-identical to today when both arrays are empty (the no-regression guarantee for every existing prompt).
- The extraction prompt builder: material-extraction instruction present, invention explicitly forbidden.
- URL text extraction: script/style stripping, truncation at the budget.
- Host-safety helper for URL fetching: https-only, private/loopback ranges rejected, redirect targets re-validated.
- Brand field validation: arrays of non-empty strings accepted, malformed rejected.
- No live-LLM or live-network integration tests (consistent with the repo).

## 9. Out of scope

- The Brand/Format/Series object-model split, the seeded format library, screenshot-to-format (project 2).
- Content pillars, pillar-to-channel mapping, cadence and the scheduler (project 3).
- Moving `style_ref_url` to brand level.
- Learning voice from the user's existing posts (weak for the onboarding case, which is a brand-new user).
- Multi-brand per user.
