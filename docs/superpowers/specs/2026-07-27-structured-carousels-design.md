# Structured Carousels — Design Spec

**Date:** 2026-07-27
**Status:** approved for planning
**Depends on:** multi-tenant beta (merged to `main`, 2026-07-27)

## 1. Summary

Today a "carousel" is five unrelated images stapled together by recency. Each idea produces one image, and `/post` groups the oldest N postable images in a category. There is no narrative, no slide roles, and no visual relationship between slides.

This change makes a post a **single structured unit**: one idea carries an ordered array of slides (hook → beats → payoff), one LLM call writes all of them together, and image generation anchors every slide to a shared reference so they read as one post.

Scope is deliberately narrow: **generation structure only.** Brand discovery, the format library, and the series model are separate later work. The schema here is shaped so those land on top without rework.

## 2. Evidence this is the right change

Both load-bearing claims were tested on 2026-07-27 before writing this spec.

**Claim 1 — an LLM can write coherent structured carousels.** Given the brand profile, the BEAGLE_EXPLAINS style guide, and a request for three carousels: 3/3 produced correct shape (`hook beat beat beat payoff`), sequential dependency between beats, and payoffs resolving the specific tension their hook opened. Cost: one Anthropic call.

**Claim 2 — chained generation holds visual and text identity.** Five slides generated through Kie with fixed-anchor references (see §5.3): the persistent footer rendered *identically* across all five, including correctly omitting the "more slides" arrow on the final panel. Headlines were correctly spelled with purple emphasis on the specified words. Five distinct camera angles as directed — the shared anchor did not flatten composition.

Two findings from that test shape the design:

- **Generated text is good enough.** Compositing real text over generated art (an HTML/canvas render layer) was under consideration and is **not needed**. This removes an entire subsystem.
- **The reference image beats art-direction prose.** The style guide's "realistic painterly illustration" instruction was ignored in favour of the reference image's photoreal look, while palette and typography rules were obeyed. Brand visual identity lives in the reference image; prose about art style is close to decorative.

The existing data corroborates the problem: SAT_MYTH's style guide says *"one image, no panels"* while `images_per_carousel = 5`, and BEAGLE_EXPLAINS already specifies a sequential multi-panel story the pipeline cannot execute.

## 3. Key decisions

1. **Slides live as `jsonb` on `ideas`, not a separate table.** Slides are always written and read as a unit and are never independently meaningful. `generations.slide_index` is the link. Trade-off accepted: no relational querying of individual slides, which nothing needs.
2. **Every post is a slide array; length 1 is a single image.** No special case for single-image categories (NOTES_APP already is one), and no legacy code path — old ideas backfill to one-slide carousels.
3. **Fixed-anchor referencing, not sequential chaining.** Slides 2..N reference `[style_ref, slide_1_image]`, never the immediately-preceding slide, so drift cannot compound. Verified in testing.
4. **Generation is two-phase, fanned out by the existing cron.** Slide 1 must finish before its siblings can reference it. The poll route already owns generation state transitions; it gains the fan-out.
5. **No text compositing.** Pure generation, per the test result.
6. **`resolved_prompt` is retired** for new ideas. Per-slide `visual` replaces it. The column stays for legacy rows.
7. **This change is strictly additive to what the app can already do.** Structured carousels are a new option alongside freeform composition, not a migration onto rails. Every existing workflow — hand-picking and reordering arbitrary images, approve/reject, retry, regenerate-with-notes — survives unchanged. See §5.4.
8. **A category is either independent or narrative, and independent is the default.** Added 2026-07-27 after live testing — see §10.

## 4. Data model changes

Migration `0008_structured_carousels.sql`.

### 4.1 `ideas.slides`

```sql
alter table ideas add column slides jsonb not null default '[]'::jsonb;
```

Shape (validated in code by zod, not by the DB):

```ts
type Slide = {
  role: "hook" | "beat" | "payoff" | "single";
  text: string;    // the words that appear on the panel
  visual: string;  // scene, camera angle, subject pose
};
```

`concept` remains, repurposed as the one-line summary of the carousel's story.

### 4.2 `generations.slide_index`

```sql
alter table generations add column slide_index int not null default 0;
create index generations_idea_slide_idx on generations(idea_id, slide_index);
```

Default `0` makes every existing row a valid slide-0 generation.

### 4.3 `generations.anchor_generation_id`

```sql
alter table generations add column anchor_generation_id uuid references generations(id);
create index generations_anchor_idx on generations(anchor_generation_id);
```

Records which slide-0 image a slide was generated against. Null for slide 0 itself, and for legacy and single-slide generations.

This exists because "which slides belong together" is otherwise only inferrable, and inference breaks the moment an anchor is regenerated (§5.6). One nullable column makes carousel membership explicit, makes the fan-out guard exact rather than approximate, and lets posting verify that a carousel's slides were all built against the *same* anchor.

### 4.4 `posts.idea_id`

```sql
alter table posts add column idea_id uuid references ideas(id);
```

Nullable **and left null for legacy posts** — the 5 existing posts each group five *unrelated* ideas, so they have no single owning idea. New posts always set it.

### 4.5 Backfill

```sql
update ideas
set slides = jsonb_build_array(
  jsonb_build_object('role', 'single', 'text', '', 'visual', concept))
where slides = '[]'::jsonb and concept <> '';
```

After this, every idea has at least one slide and there is exactly one code path.

Backfilled legacy ideas are **historical records, not regeneration targets** — a legacy BEAGLE_EXPLAINS idea ends up with one `single` slide despite its category's `images_per_carousel = 5`, which is correct, because that is what was actually generated and posted. Only newly generated ideas carry full slide arrays.

## 5. Generation flow

### 5.1 Idea generation

`buildIdeaSystemPrompt` gains carousel instructions; the zod output schema becomes:

```ts
IdeasOutput = z.object({
  ideas: z.array(z.object({
    category: z.string(),
    concept: z.string(),
    slides: z.array(z.object({
      role: z.enum(["hook", "beat", "payoff", "single"]),
      text: z.string(),
      visual: z.string(),
    })),
  })),
});
```

Slide count comes from `category.images_per_carousel`. The prompt requires:

- exactly one `hook` first and one `payoff` last when count > 1; a single `single` slide when count == 1
- each beat must depend on the one before it — reorderable panels are a failure
- the payoff resolves the hook's specific tension, not a generic lesson
- panel `text` is literally what appears on the image: one short phrase, no panel numbers or labels
- **structural variety across the batch** — the test showed all three carousels collapsing into one identical template with three identically-shaped payoff lines. One prompt clause, materially better output.

**Shape validation happens after parsing, before insert.** Malformed carousels are discarded rather than repaired, and counted into the existing `filteredOut` return value alongside AI-filter rejections. No row is written, so nothing is recorded in `ai_filter_reason` — that column only describes ideas that exist. Testing showed 3/3 correct shape, so the discard rate should be low; if it proves otherwise, that is a prompt problem, not a reason to build repair logic.

### 5.2 Slide prompt construction

`buildImagePrompt` is replaced by `buildSlidePrompt(styleGuide, slide, position, total, chained)`:

```
{style_guide}

SPECIFIC CONTENT FOR THIS IMAGE:
Panel {position} of {total}.

Text on panel: "{slide.text}"
Scene: {slide.visual}

Follow every rule in the style guide, including any element it specifies as
appearing on every panel.

ROLE DIRECTION: {role-specific direction}

{reference note}
```

Role direction is a short fixed string per role (anchor / middle-beat-with-distinct-camera / payoff-tightest-crop). Reference note differs for 1 vs 2 references — the two-reference wording that worked in testing is kept verbatim.

Note the style guide is *not* required to restate footer rules in the prompt; the generic "any element it specifies as appearing on every panel" clause covers footers without hardcoding a BEAGLE_EXPLAINS-specific concept.

### 5.3 Two-phase image generation

**Phase 1 — `submitGenerations`:** for each eligible idea, submit **only slide 0** with `input_urls = [styleUrl]`. One `generations` row, `slide_index = 0`.

**Phase 2 — poll route fan-out:** when a `slide_index = 0` generation is ingested successfully and its idea has `slides.length > 1`, submit slides 1..N-1 with `input_urls = [styleUrl, slide0.public_url]`. Those poll and ingest normally.

Each fanned-out generation records `anchor_generation_id = <the slide-0 generation>`.

**The fan-out must be idempotent.** The cron runs repeatedly, so "did slide 0 just succeed" is not a safe trigger. The guard is: for a succeeded slide-0 generation `G`, fan out only if **no generations exist with `anchor_generation_id = G`**.

Note this is deliberately keyed on the anchor rather than on "does the idea have any slide > 0" — the weaker guard would make re-anchoring (§5.6) impossible, since an earlier run's slides would block a new one forever.

The idea reaches `generated` only when *every* slide has a succeeded generation — currently it flips on the first one.

`createKieTask` changes from `styleUrl: string` to `inputUrls: string[]`.

### 5.4 Posting — additive, not a replacement

**Freeform composition is preserved in full.** The composer today is already a manual tool: auto-fill is only the default, and `remove` / `add` / `move` let any succeeded image in the category be swapped in and reordered with no LLM involved. That capability is not removed, reduced, or hidden.

What changes is only **how the composer's default fill is chosen**, plus a new way to pick a starting point:

- **Carousel fill (new).** Choose an idea whose slides have all succeeded; the composer loads its images pre-ordered by `slide_index`. Still fully editable afterwards — remove, reorder, swap in anything else.
- **Freeform fill (existing).** The current pool picker over loose succeeded generations, unchanged.

`selectAutoFill`'s recency grouping is therefore **replaced as a default, not deleted as a capability** — it becomes slide-aware so it stops mixing slides from different carousels, while the underlying pool remains every postable image in the category.

`posts.idea_id` is set for carousel-sourced posts and left null for freeform ones. That gives the nullable column a permanent meaning rather than making it a legacy artifact: null means "hand-assembled", non-null means "this post is that carousel".

**Nothing requires a carousel.** A five-image post of five unrelated images, hand-picked in whatever order, remains a first-class thing the product does.

### 5.5 Manual authoring (no LLM)

Today the only path into `ideas` is `generateIdeas`, so a carousel cannot be created without an LLM call. Slides as a structured array make hand-authoring natural, and it is the manual counterpart to generated carousels: same table, same generation path, same posting path — only the author differs.

A dialog on `/ideas` writes an idea row directly:

- category, `concept` (the one-line summary), and one row per slide (`role`, `text`, `visual`)
- slide count defaults to the category's `images_per_carousel` but is **not constrained by it** — a hand-authored carousel may be any length, including one
- inserted with `approved = true`, `status = "approved"`, a fresh `batch_id`, and empty `ai_filter_reason`

It skips `pending_review` deliberately: that queue exists to review the model's output, and there is nothing to review about text the user just typed.

Everything downstream is unchanged — the idea flows through the same two-phase generation and the same composer.

**One validation consequence.** `app/api/posts/create/route.ts` currently rejects a post unless `generation_ids.length === category.images_per_carousel`. That breaks any carousel whose slide count differs from the category default, which manual authoring makes possible. The check becomes: for a carousel-sourced post, the count must equal that **idea's slide count**; for a freeform post, `images_per_carousel` still applies.

### 5.6 Retry and failure semantics

Two cases the two-phase model creates that the single-image pipeline never had.

**Retrying a middle slide** (`slide_index > 0`) is safe and cheap: resubmit that slide against the same anchor image, recording the same `anchor_generation_id`. The other slides are untouched. Posting picks the newest succeeded generation per `(idea, slide_index)` *within one anchor*, extending the "newest succeeded per idea" rule the posting route already applies.

**Retrying the anchor after fan-out is a whole-carousel regeneration, and must be presented as one.** Slides 2..N were generated against the old slide 1; a new anchor invalidates all of them, and silently swapping it produces a carousel whose first panel no longer matches the rest — visually broken in a way nothing would flag. So:

- The gallery offers "regenerate this carousel", not a per-slide retry, on slide 1 once siblings exist.
- Accepting creates a new slide-0 generation, which fans out afresh under its own `anchor_generation_id`.
- Prior generations are **not deleted** — they stay as history, consistent with how failed generations are already retained. They simply stop being the newest anchor.

**A carousel is postable only if every slide has a succeeded generation under the same anchor.** That is the check, and it is exact rather than count-based.

**Partial carousels must not dead-end.** If a slide fails past its retries, the remaining images are still good work and must stay usable. Today `postables` only includes generations whose idea has reached `generated`, so a carousel stuck at 4 of 5 would hide four perfectly good images. The freeform pool therefore includes **every succeeded generation in the category**, regardless of whether its idea completed. The escape hatch from a broken carousel is the freeform composer, which requires no new UI — only that the pool stops being gated on idea completion.

## 6. Files touched

| file | change |
|---|---|
| `supabase/migrations/0008_structured_carousels.sql` | new |
| `lib/types.ts` | `Slide`, `Idea.slides`, `Generation.slide_index`, `Generation.anchor_generation_id`, `Post.idea_id` |
| `lib/athena/prompts.ts` | carousel schema + instructions, shape validation |
| `lib/athena/generate-ideas.ts` | validate and insert slides |
| `lib/athena/image-prompt.ts` | `buildSlidePrompt` replaces `buildImagePrompt` |
| `lib/athena/kie.ts` | `createKieTask` takes `inputUrls: string[]` |
| `lib/athena/submit-generations.ts` | submit slide 0 only |
| `app/api/jobs/poll/route.ts` | phase-2 fan-out keyed on `anchor_generation_id`; idea completes only when all slides do |
| `lib/athena/carousel.ts` | slide-aware assembly; freeform pool no longer gated on idea completion |
| `app/(app)/gallery/gallery-card.tsx` | per-slide retry vs. whole-carousel regenerate on the anchor |
| `app/(app)/ideas/*` | manual authoring dialog + server action |
| `app/api/posts/create/route.ts` | count validation becomes slide-aware for carousel posts |
| `app/(app)/post/*` | carousel fill alongside the existing freeform pool |
| `app/(app)/gallery/*` | group generations by idea |
| `tests/*` | prompt shape, fan-out idempotency, assembly ordering, post count validation |

Also folded in: the uncommitted `uploadStyleRef` fix (per-user/per-category upload path — a cross-tenant defect where concurrent users overwrite each other's style reference at a shared path).

**Natural phasing.** This is larger than one sitting and splits cleanly at the generation/consumption boundary: **Phase A** = migration, types, prompts, idea generation, slide prompts, two-phase submission and fan-out, and manual authoring (§5.5) — everything through images landing in the gallery, whether the slides were written by the model or by hand. **Phase B** = posting and UI (carousel fill, `/post` rework, slide-aware count validation, gallery grouping).

Manual authoring belongs in Phase A because it exercises the same schema and generation path as generated carousels, which makes it a cheap independent check that the slide model works before any UI depends on it. Phase A is independently verifiable: correct slides in the database with all their images generated.

One constraint on Phase A: `selectAutoFill` groups loose generations by recency, so once an idea yields five sibling generations its *default fill* would assemble them in arbitrary order — all five share an `idea_created_at`, and nothing sorts by `slide_index`. Phase A must therefore make the default fill skip multi-slide ideas. The freeform pool is unaffected and every image remains hand-pickable throughout; only the pre-filled suggestion is constrained until Phase B teaches it to assemble carousels in order. Silently pre-filling a scrambled carousel is the worse failure.

## 7. Risks

1. **Cloudinary URLs as Kie `input_urls` is unverified.** Testing chained on raw Kie result URLs. Cloudinary URLs are public HTTPS and should work, and using them is preferable since Kie's temp URLs expire — but this must be verified in the first implementation task, before the fan-out is built on it. **Verified 2026-07-27:** a Cloudinary `public_url` submitted as the second `input_urls` entry against `BEAGLE_EXPLAINS` succeeded on the first run (`gpt-image-2-image-to-image`, task completed with a `resultUrls` output). Accepted.
2. **Latency roughly doubles per carousel.** Slide 1 must complete (~1–3 min) before siblings start. Acceptable for a cron-driven pipeline; worth surfacing in the UI as a two-stage state.
3. **A failed slide 0 blocks the whole carousel.** Kie fails ~40% of the time on long BEAGLE_EXPLAINS prompts and ~10% elsewhere. The style-guide rewrite (3358 → 2372 chars) reduces this, and manual retry already exists, but slide 0 warrants automatic retry since it gates four other slides.
4. **Partial carousels.** If slide 3 of 5 fails permanently the idea never reaches `generated`. Mitigated by §5.6: middle slides retry against the same anchor, and the freeform pool stops being gated on idea completion so the surviving images stay usable.
5. **Anchor regeneration is a footgun if exposed as a plain retry.** Replacing slide 1 after fan-out silently invalidates every other slide. §5.6 requires it be presented as regenerating the whole carousel; `anchor_generation_id` is what makes that enforceable rather than a convention.

## 8. Out of scope

Brand / format / series object model. Brand discovery and website extraction. The format library and screenshot-to-format. Scoped directives and correction memory. Cadence and scheduling. Buffer multi-connection (designed, parked — see the project memory). Text compositing (ruled out by testing).

## 9. Verification

- Migration applies cleanly and the backfill leaves every existing idea with exactly one slide.
- A fresh generation run produces a 5-slide idea whose slides pass shape validation.
- Slide 0 generates; the cron fans out slides 1–4 referencing it; the idea flips to `generated` only after all five succeed.
- `/post` assembles the five in `slide_index` order and posts one Buffer carousel.
- The 34 imported legacy ideas and their generations continue to render in the gallery.
- A hand-authored carousel with no LLM call generates and posts end to end, including one whose slide count differs from its category's `images_per_carousel`.
- Freeform composition still works: five unrelated images, hand-picked in a chosen order, post successfully.
- Retrying a middle slide leaves the other four untouched and keeps the same `anchor_generation_id`.
- Regenerating a carousel produces a fresh anchor plus a fresh set of siblings under it, leaves the previous generations in place as history, and posts the new set — not a mix of the two.
- A carousel deliberately stalled at 4 of 5 still shows its four succeeded images in the freeform pool, and they can be posted alongside another image.

## 10. Post type: independent vs narrative

**Added after live testing revealed a design error in decisions 2 and 7 above.**

### What went wrong

Phase A read `images_per_carousel = 5` as "this is a five-part story" and applied the slide/role/anchor machinery to every category. Four of the five aren't stories.

SAT_MYTH's style guide describes a **standalone poster**: an orange `MYTH:` tag, the statement struck through with a hand-drawn X, one visual metaphor, explicitly "no panels, no split screens." Applied verbatim to all five slides of a generated carousel, it produced this on the *payoff* panel:

> **MYTH:** ~~UNDERSTANDING BEATS MEMORIZING, EVERY TIME.~~

The correct insight, tagged as a myth and crossed out. The format inverted its own meaning, and the same happened on the explainer beats.

Five independent posters in one carousel post was never broken — it is a legitimate format and it is what that style guide is written for. The error was making narrative the default rather than an opt-in, which turns Phase A from additive into a regression for SAT_MYTH, BRAIN_TEASER, COMIC, and NOTES_APP.

### 10.1 `categories.post_type`

```sql
alter table categories
  add column post_type text not null default 'independent'
  check (post_type in ('independent', 'narrative'));
```

- **`independent`** — N images, each a complete standalone post. One idea per image, exactly one slide with role `single`, no anchor chaining. `shouldFanOut(1, …)` is already false, so nothing fans out. This is the pre-Phase-A behaviour, now expressed in the slide model rather than beside it.
- **`narrative`** — N slides forming one story. One idea per post, roles, anchor chaining, everything §5 describes.

**Defaulting to `independent` is the point.** It makes Phase A additive in behaviour as well as in schema: nothing changes for any existing category until it is explicitly opted in.

### 10.2 `categories.role_guides`

```sql
alter table categories add column role_guides jsonb not null default '{}'::jsonb;
```

Shape: `{ hook?: string; beat?: string; payoff?: string; single?: string }`.

One style guide cannot serve three jobs. An opener has to stop the scroll, an explainer panel has to be readable, a closer has to land — and only the format's author knows how they differ visually. `style_guide` keeps what is shared (palette, character, typography, any persistent footer); `role_guides` holds what is specific:

```
hook:   Orange MYTH tag top-left. Statement struck through with a hand-drawn X.
beat:   No tag, no X. This panel explains rather than debunks.
payoff: No tag, no X. The resolved truth, stated clean.
```

That scoping is what stops the payoff being crossed out.

Phase A's role direction was generic prose — "match the reference panels, use a different camera angle" — deliberately format-agnostic, and therefore incapable of expressing "the X belongs only on slide 1." Generic direction handles *composition*; only the format author can supply *treatment*.

### 10.3 Generation

`buildIdeaSystemPrompt` branches on `post_type`:

- `independent` — ask for `count` ideas, each carrying exactly one slide with role `single`. No carousel-structure instructions.
- `narrative` — ask for carousels of `images_per_carousel` slides, as §5.1 describes.

`buildSlidePrompt` composes `style_guide` + `role_guides[slide.role]` (omitted when absent) + the slide's content. Everything downstream — submission, fan-out, the sweep, completion, posting, the gallery — already handles both cases and needs no change, because a one-slide idea was always a supported shape.

### 10.4 Not in scope here

Authoring these fields with AI assistance — describing a format in plain English, or uploading a screenshot of a post to reverse-engineer it — is a genuine subsystem with its own design questions and gets its own spec. It is safe to defer because of decision 7's corollary: **the assist lane drafts into the manual lane's objects and never gets its own.** The manual editor built here is the surface such an assistant fills in and the one used to correct it, so it is not throwaway work.
