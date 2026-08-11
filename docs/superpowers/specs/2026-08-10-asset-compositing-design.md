# Asset Compositing (B1: fixed overlays) — Design Spec

**Date:** 2026-08-10
**Status:** approved for planning
**Supersedes:** `2026-07-30-category-overlays-design.md` — see §8 for the defect that spec contained.
**Depends on:** the role system (`categories.role_guides`/`role_ref_urls`, `Slide["role"]`); the ingest path (`ingestImage` in `app/api/jobs/poll/route.ts`); the Test Run preview (`app/api/categories/draft/preview/route.ts`, `lib/style-ref-client.ts`'s `pollTask`); `uploadStyleRefImage` (`app/(app)/config/actions.ts`); `sharp` 0.35.3 (already a dependency, already used in `ingestImage`); the brand ownership `categories` gained in `2026-08-10-multi-brand-design.md`.

## 1. Summary

Composite a configurable list of overlay images — a logo, a QR code — onto generated slides, targeted by role and positioned by percentage, so placement scales across this app's aspect ratios.

A QR code that actually scans can never come from a generative model. It has to be composited deterministically after generation. That rule — **content that must be exact is composited; content that may be approximate is generated** — is what separates this project from project C.

### Scope: this spec is B1 of three

The data model and pipeline are designed for all three phases; **only B1 is in scope here.** B2 and B3 get their own specs and migrations.

- **B1 (this spec).** Fixed overlays: an image configured on the category, composited onto every matching slide. Includes the two-artifact ingest change (§3), which both later phases depend on. Ships the QR code and logo.
- **B2 — per-idea slots.** A category defines a placement with no image (`slot_key`, e.g. `speaker_photo`); each idea fills it with its own upload (`idea_overlay_fills`). This is the case a real coworker hit and could not do: a twelve-speaker event series where the layout is constant and the face changes. An unfilled slot publishes without it and is badged visibly in Gallery and the composer — flagged, never blocking.
- **B3 — treatments.** `shape` (`none|circle|rounded`), `border_width_pct`, `border_color`, `tint` (`none|grayscale|brand`), `tint_color`, `shadow`. These matter more than they look: background removal was cut on cost, so an uploaded headshot arrives as a rectangle carrying whatever background it was shot against. **A circular mask with a border does most of what a cutout would have done**, by cropping the background out of frame. `tint: brand` is grayscale plus one brand colour — a monotone. True two-colour duotone needs channel remapping and is out of scope for all three phases.

## 2. Data model

```sql
create table category_overlays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  name text not null,
  image_url text not null,
  roles text[] not null,        -- any subset of hook/beat/payoff/single
  corner text not null check (corner in ('top-left','top-right','bottom-left','bottom-right','center')),
  margin_pct numeric not null default 5,
  size_pct numeric not null default 15,   -- overlay width as a percentage of the base image's width
  opacity numeric not null default 100,   -- 0-100
  sort_order int not null default 0,      -- stacking order when several target one role
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Owner-scoped RLS (`for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)`), matching every per-tenant table here, plus the shared `set_updated_at()` trigger.

**No `brand_id`.** Overlays hang off `category_id`, which carries the brand — the same inheritance `ideas` and `posts` use.

**Several overlays may target one role** — a logo and a QR code can both sit on the payoff slide, composited in `sort_order`. **An overlay with an empty `roles` array is invalid** and is rejected at the form and validation layer, not silently composited nowhere.

B2 adds `slot_key` and relaxes `image_url` to allow exactly one of the two; B3 adds the treatment columns. Neither is created here — dead columns invite dead code.

## 3. The two-artifact change

**This is the part the superseded spec got wrong, and it is load-bearing.**

`ingestImage` uploads the generated JPEG and then passes that URL into `fanOutCarousel` as the anchor slides 2..N are generated *against* (`app/api/jobs/poll/route.ts:78`). `sweepOrphanedAnchors` re-reads the stored `anchor.public_url` to do the same (`:385`). Compositing in place — as the superseded spec proposed — would burn the QR code into the image Kie uses as its visual reference, and the model would try to reproduce a smeared QR code on every subsequent slide of every carousel.

So:

- **`generations.public_url` keeps its current meaning: the clean image.** No backfill, no change to any generation path.
- **`generations.composited_url` (new, nullable)** holds the published artifact, written only when at least one overlay applies.
- **`publishedImageUrl(gen) => gen.composited_url || gen.public_url`** is the single chokepoint every *display and posting* site goes through: Gallery, the Post composer, and the `imageUrls` array `app/api/posts/create/route.ts` sends to Buffer.

The asymmetry is the design: **the model only ever sees clean images; humans and Buffer only ever see finished ones.** Every new read site must be one or the other deliberately — a generation path reaching for `composited_url` is a defect, and so is a publish path reading `public_url` directly.

Every existing consumer, enumerated (`grep -rn "public_url" app lib`), sorted into its side. The plan must move the first group and leave the second alone:

**Publish and display — switch to `publishedImageUrl`:**

| Site | What it feeds |
|---|---|
| `app/api/posts/create/route.ts:275`, `:440` | the `imageUrls` array sent to Buffer |
| `app/api/posts/create/route.ts:260`, `:396` | the "has a successful image" guard preceding each |
| `app/(app)/gallery/gallery-card.tsx:28-30`, `:209-211` | the gallery grid and the superseded-history dialog |
| `app/(app)/post/page.tsx:36` | the postable-image pool |
| `app/(app)/post/[ideaId]/page.tsx:86`, `:95`, `:111` | the composer's pool and slide map |
| `app/(app)/post/[ideaId]/composer.tsx:241-243`, `:259` | the composer's image picker |

**Generation — must keep reading `public_url`:**

| Site | Why |
|---|---|
| `app/api/jobs/poll/route.ts:385` | `sweepOrphanedAnchors` re-anchors a carousel fan-out |
| `lib/athena/resubmit-slide.ts:99` | retrying one slide passes the anchor to Kie as an `input_url` |

`lib/athena/carousel.ts:7` types a view model carrying `public_url`; it is fed from a display path, so the value flowing through it becomes the published URL while the field name stays. Rename it there if it reads confusingly, but do not change what feeds it.

### Re-compositing is cheap

Keeping the clean image means re-compositing costs one `sharp` pass and one Cloudinary upload — **no Kie call and no AI spend.** That is what makes B2's "fill the speaker photo after generating" an ordinary operation rather than a regeneration.

Deliberately excluded: editing a category's overlay configuration does **not** retro-composite existing posts. Config changes affect future generations only. Re-compositing is triggered per idea, by B2's slot fills.

## 4. The compositing function

`lib/athena/overlay-composite.ts`:

```ts
compositeOverlays(base: Buffer, overlays: CategoryOverlay[], role: Slide["role"]): Promise<Buffer | null>
```

1. Filter to `active` overlays whose `roles` includes `role`, sorted by `sort_order`.
2. **If the list is empty, return `null`** — the caller then skips the second upload entirely. Every category today has no overlays, so the common path costs one array filter.
3. For each overlay: fetch its `image_url`, resize to `size_pct`% of the base's real width (aspect preserved), compute the pixel offset from `corner` + `margin_pct` against the base's real dimensions (`sharp(base).metadata()`), apply `opacity` to the resized layer's alpha, composite onto the running buffer.
4. Return the final buffer.

The function is not pure — it fetches each overlay over the network. **The placement arithmetic is**, and it is extracted as its own function and is what gets unit-tested (§7):

```ts
computePlacement(base: {width: number; height: number},
                 overlay: {width: number; height: number},
                 o: Pick<CategoryOverlay, "corner" | "margin_pct" | "size_pct">
                ): { left: number; top: number; width: number; height: number }
```

An overlay whose fetch fails must not fail the whole ingest: log it, skip that layer, continue with the rest. A generation that succeeded should not be lost because a logo URL 404'd.

## 5. Two call sites

**Production — `ingestImage`.** After the existing JPEG encode and upload (which stays exactly as-is and continues to feed the anchor), load the category and composite:

- **The category row**, by `idea.category_key` + `gen.user_id` — the same query `fanOutCarousel` already runs in this file.
- **The slide's role**, already in scope: `idea.slides[gen.slide_index].role`.

If `compositeOverlays` returns non-null, upload the result and write `composited_url`. If it returns null, write nothing.

**Test Run — `GET /api/categories/draft/preview`.** Gains optional `categoryId` and `role` query parameters; `pollTask` in `lib/style-ref-client.ts` forwards them only when supplied. When both are present and compositing produces a buffer, the route returns it as a base64 data URI **in a separate `compositedUrl` field, leaving `resultUrl` clean.** Nothing is persisted, keeping that card's "nothing is saved" copy literally true.

**The two artifacts must stay separate on the wire, exactly as they are in the database.** An earlier draft of this spec put the composited image into `resultUrl` itself, reasoning that no client change was needed because a data URI renders like any other URL. That was wrong in precisely the way this project exists to prevent: `preview-pane.tsx` stores the anchor poll's result into `run.anchor.url` and then sends that same value back as `anchorImageUrl` for the fan-out, which reaches `createKieTask` as an `input_url`. Overwriting `resultUrl` hands Kie a QR-stamped image as the visual reference for every later preview slide — the poisoned anchor, through the preview door.

So `pollTask` returns both: `url` (clean — what goes back to Kie) and `displayUrl` (composited when present — what the user sees). The preview image renders `displayUrl`; the fan-out sends `url`.

This also keeps "Cement selected as references" working. That flow promotes a chosen preview image into `categories.role_ref_urls`, a Kie seed input for all future real generations, and `promote-refs` validates each entry as an https URL and rejects the whole request if any one fails. Cementing must send `url`, never `displayUrl`.

**Style-reference generation must never composite.** `generateStyleRef`/`persistStyleRef` have no slide role, and a brand's reference image is a template asset, not a published post. The route composites only when both parameters are present; a poll missing either behaves exactly as today.

## 6. UI

A new section in the category editor (`app/(app)/config/category-manager.tsx`), alongside the role-guides UI: a list of the category's overlays, each with an image upload (reusing `uploadStyleRefImage` — no new upload path), a role checkbox set, a corner dropdown, and margin/size/opacity inputs. Add and delete controls, matching the form patterns already dense in that file.

This form work is the bulk of B1 — the compositing itself is comparatively small.

## 7. Testing

`computePlacement` is unit-tested directly, per this repo's convention of testing the logic around image work rather than the pixels: all five corner values; `margin_pct` at 0; an overlay wider than the margin allows; a non-square base (this app runs 4:5 and 1:1) confirming `size_pct` keys off width and the aspect ratio is preserved.

`publishedImageUrl` is unit-tested for both branches, including `composited_url` being an empty string rather than null.

No live-`sharp` or live-network tests, consistent with the repo — nothing here tests image output, only the logic around it.

## 8. What the superseded spec got wrong

`2026-07-30-category-overlays-design.md` §4 states that `compositeOverlays` "slots in right before that existing encode step" in `ingestImage`. That would overwrite the image used as the carousel anchor, corrupting every multi-slide generation from the second slide onward. §3 here replaces that with the two-artifact model. The rest of that spec's shape — per-category configuration, role targeting, percentage placement, `sort_order` stacking — survives intact and is carried forward above.

## 9. Out of scope

- **Background removal.** Cut on cost. B3's shape mask is the mitigation.
- **True two-colour duotone** (§1).
- Per-idea slots and treatments — B2 and B3.
- A drag-and-drop placement editor. Numeric inputs and dropdowns only.
- Animated or video overlays.
- Targeting a specific slide index within a role (e.g. "only the 3rd beat"). Role-level only, matching `role_guides`/`role_ref_urls`.
- Retro-compositing existing posts when overlay config changes (§3).
- Any change to `role_guides`/`role_ref_urls`. Those are prompt and seed-image inputs to generation; compositing is a separate, later, post-processing step and does not touch them.
