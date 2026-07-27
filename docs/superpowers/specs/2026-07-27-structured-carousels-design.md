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

### 4.3 `posts.idea_id`

```sql
alter table posts add column idea_id uuid references ideas(id);
```

Nullable **and left null for legacy posts** — the 5 existing posts each group five *unrelated* ideas, so they have no single owning idea. New posts always set it.

### 4.4 Backfill

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

**The fan-out must be idempotent.** The cron runs repeatedly and a retried slide 0 produces a *second* slide-0 generation, so "did slide 0 just succeed" is not a safe trigger. The guard is: fan out only if the idea has **no generations with `slide_index > 0`**. Combined with the `(idea_id, slide_index)` index this is one cheap query, and it makes double-firing structurally impossible rather than merely unlikely.

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

## 6. Files touched

| file | change |
|---|---|
| `supabase/migrations/0008_structured_carousels.sql` | new |
| `lib/types.ts` | `Slide`, `Idea.slides`, `Generation.slide_index`, `Post.idea_id` |
| `lib/athena/prompts.ts` | carousel schema + instructions, shape validation |
| `lib/athena/generate-ideas.ts` | validate and insert slides |
| `lib/athena/image-prompt.ts` | `buildSlidePrompt` replaces `buildImagePrompt` |
| `lib/athena/kie.ts` | `createKieTask` takes `inputUrls: string[]` |
| `lib/athena/submit-generations.ts` | submit slide 0 only |
| `app/api/jobs/poll/route.ts` | phase-2 fan-out; idea completes only when all slides do |
| `lib/athena/carousel.ts` | idea-based assembly replaces `selectAutoFill` |
| `app/(app)/post/*` | carousel-per-idea composer |
| `app/(app)/gallery/*` | group generations by idea |
| `tests/*` | prompt shape, fan-out decision, assembly ordering |

Also folded in: the uncommitted `uploadStyleRef` fix (per-user/per-category upload path — a cross-tenant defect where concurrent users overwrite each other's style reference at a shared path).

**Natural phasing.** This is larger than one sitting and splits cleanly at the generation/consumption boundary: **Phase A** = migration, types, prompts, idea generation, slide prompts, two-phase submission and fan-out (everything through images landing in the gallery). **Phase B** = posting and UI (carousel assembly, `/post` rework, gallery grouping). Phase A is independently verifiable: correct slides in the database with all their images generated.

One constraint on Phase A: `selectAutoFill` groups loose generations by recency, so once an idea yields five sibling generations its *default fill* would assemble them in arbitrary order — all five share an `idea_created_at`, and nothing sorts by `slide_index`. Phase A must therefore make the default fill skip multi-slide ideas. The freeform pool is unaffected and every image remains hand-pickable throughout; only the pre-filled suggestion is constrained until Phase B teaches it to assemble carousels in order. Silently pre-filling a scrambled carousel is the worse failure.

## 7. Risks

1. **Cloudinary URLs as Kie `input_urls` is unverified.** Testing chained on raw Kie result URLs. Cloudinary URLs are public HTTPS and should work, and using them is preferable since Kie's temp URLs expire — but this must be verified in the first implementation task, before the fan-out is built on it.
2. **Latency roughly doubles per carousel.** Slide 1 must complete (~1–3 min) before siblings start. Acceptable for a cron-driven pipeline; worth surfacing in the UI as a two-stage state.
3. **A failed slide 0 blocks the whole carousel.** Kie fails ~40% of the time on long BEAGLE_EXPLAINS prompts and ~10% elsewhere. The style-guide rewrite (3358 → 2372 chars) reduces this, and manual retry already exists, but slide 0 warrants automatic retry since it gates four other slides.
4. **Partial carousels.** If slide 3 of 5 fails permanently, the idea is stuck between states. Retry of an individual slide must work without regenerating the anchor.

## 8. Out of scope

Brand / format / series object model. Brand discovery and website extraction. The format library and screenshot-to-format. Scoped directives and correction memory. Cadence and scheduling. Buffer multi-connection (designed, parked — see the project memory). Text compositing (ruled out by testing).

## 9. Verification

- Migration applies cleanly and the backfill leaves every existing idea with exactly one slide.
- A fresh generation run produces a 5-slide idea whose slides pass shape validation.
- Slide 0 generates; the cron fans out slides 1–4 referencing it; the idea flips to `generated` only after all five succeed.
- `/post` assembles the five in `slide_index` order and posts one Buffer carousel.
- The 34 imported legacy ideas and their generations continue to render in the gallery.
