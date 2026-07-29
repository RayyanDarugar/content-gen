# Brand Design Tokens — Design Spec

**Date:** 2026-07-29
**Status:** approved for planning
**Depends on:** brand extraction (merge `ec0a7a4`) — this extends its endpoint, form, and prompt rather than adding a surface.
**Blocks:** suggested post types (`2026-07-29-suggested-post-types-design.md`), which needs the brand's real palette and type so a drafted `style_guide` says something specific.

## 1. Summary

Today visual brand identity reaches a post **only** through `categories.style_ref_url` and the cemented role refs — an image. Nothing captures "our palette is these hex values, our type is this family," so every drafted `style_guide` describes a look in generic prose.

This scrapes design signal from the site already being read during brand extraction — colors, fonts, and a short visual note — stores them on the brand, and feeds them into style-guide drafting as the **default a post type may deliberately override**.

**Decisions locked with Rayyan (2026-07-29):** its own small project sequenced *before* suggested post types; structured lists plus a notes field, mirroring `proof_points`/`standing`.

## 2. Why a separate extraction path

`extractReadableText` (`lib/fetch-page.ts`) strips `<style>` **and `<head>`** before stripping all tags. That discards exactly the signal wanted: CSS blocks, `<link rel="stylesheet">` hrefs, the Google Fonts link, and `<meta name="theme-color">`. Design-token parsing therefore runs over the **raw HTML**, before that stripping — a separate function, not a change to the text extractor (whose behaviour is deliberately conservative and has already been regressed twice).

## 3. Code finds candidates, the model judges them

Regex reliably *finds* hex values, `font-family` declarations, Google Fonts links, and custom properties. It cannot decide which of forty colors in a Tailwind bundle are the brand's versus shadows, grays, and browser defaults — that is judgment.

So `lib/design-tokens.ts` produces a ranked candidate list, and that list rides into the **existing** brand-extraction call. The model already reading the page returns `colors`, `fonts`, and `visual_notes` as three more fields on the same draft. **One LLM call, not two.**

### Parsing, in priority order (by signal strength)

1. `<meta name="theme-color">` — an explicit brand-color declaration. Rare, definitive.
2. Google Fonts `<link href="…css2?family=Inter:wght@…">` — the most reliable font signal on the modern web. Parse family names out of the query string.
3. CSS custom properties (`--brand-primary: #0f172a`) from `<style>` blocks and linked sheets. Property names carry meaning: `--primary`/`--brand`/`--accent` outrank `--gray-300`.
4. `@font-face { font-family: … }` and `font-family:` declarations.
5. Remaining hex/rgb values ranked by frequency — the fallback for Tailwind-compiled sites, where brand colors appear many times and incidental ones once.

Candidates are normalised (hex lowercased and expanded from shorthand, fonts stripped of quotes and fallback stacks) and de-duplicated before ranking, and the list is capped so a bundle cannot flood the prompt.

### Fetching linked stylesheets

Linked sheets are fetched through the **existing** hardened machinery — `assertFetchableUrl`, per-hop redirect validation, `AbortSignal.timeout`, size caps — all unchanged. **Capped at 3 sheets** so a site with a dozen bundles cannot stall extraction. A sheet that fails to load is skipped silently; it degrades the result, it does not fail the run (matching how a failed document already behaves).

## 4. Schema (migration 0016)

- `brand_profiles.colors jsonb not null default '[]'::jsonb` — hex strings, most prominent first.
- `brand_profiles.fonts jsonb not null default '[]'::jsonb` — family names.
- `brand_profiles.visual_notes text not null default ''` — a short prose note for anything else worth carrying (imagery style, logo treatment observations).

`colors` and `fonts` reuse `parseBrandList`, `mergeList`, and the `BrandListEditor` built for proof points, so a wrong hex is one click to delete and the propose-and-approve flow works unchanged. `visual_notes` is a textarea like the other prose fields.

## 5. How they reach a post

`brandBlock` gains a visual-identity block when any of the three are non-empty — so every prompt surface sees it, exactly as proof points do, and **stays byte-identical when all three are empty** (the same guarantee, same exact-match test, since six surfaces read it).

The consumer that matters is style-guide drafting, in both the wizard (`buildDraftSystemPrompt`) and later the suggestion endpoint. The prompt instructs it to **use the brand's actual palette and type as the default** for a drafted `style_guide`, while stating plainly that a post type may deliberately override them — a meme series rendered in corporate brand colors would be wrong. Prompt layering already produces this: the style guide is the more specific instruction, so it wins.

## 6. Honesty in the UI

Extraction is best-effort: declared CSS is reachable server-side, computed CSS is not (which is why Peek is a browser extension). The form labels the section **"Found on your site — check these"**, not "your brand colors are." Colors render as swatches beside their hex values so a wrong one is obvious at a glance.

## 7. Error handling

- Stylesheet fetch failures: skipped, extraction continues; noted in the existing `warnings[]` when a sheet was expected and unreachable.
- A site with no design signal: all three fields come back empty. That is a correct answer, not a failure — the prompt must not invent a palette, exactly as it must not invent proof points.
- Malformed CSS: the parser returns what it could read rather than throwing.

## 8. Testing

The parser is pure and gets real fixtures:
- A page with a Google Fonts link and CSS custom properties — the clean case.
- A Tailwind-style bundle where frequency ranking has to do the work.
- A page with `<meta name="theme-color">` — asserted to outrank frequency-derived colors.
- A page with **no design signal at all** — empty arrays, not garbage.
- Malformed/truncated CSS — returns partial results without throwing.
- Normalisation: shorthand hex expanded, case-folded, `font-family: "Inter", sans-serif` reduced to `Inter`, duplicates collapsed.

Plus: `brandBlock` byte-identical when all three fields are empty (exact `toBe`), and carrying colors/fonts when set.

## 9. Out of scope

- A headless browser and computed CSS — the Peek-grade version.
- Logo and asset extraction: that is project 1b (brand assets), which composites real files rather than describing them.
- Applying colors mechanically to generated images; this feeds *prompt text*, and the reference image remains the dominant visual signal per this repo's own measured finding.
- Per-series visual overrides beyond what a `style_guide` already expresses.
