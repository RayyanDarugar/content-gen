# Asset Compositing B3: Overlay Treatments — Design Spec

**Date:** 2026-08-11
**Status:** approved for planning
**Builds on:** `2026-08-10-asset-compositing-design.md` (B1) and `2026-08-11-overlay-slots-design.md` (B2) — the two-artifact model, `compositeOverlays`, `computePlacement`, `resolveOverlaysForIdea`, the Test Run placeholder.

## 1. Summary

Shape masks, borders, tints and drop shadows for composited overlays.

These matter more than they look. **Background removal was cut on cost**, so an uploaded speaker headshot arrives as a rectangle carrying whatever background it was shot against. A circular mask with a border does most of what a cutout would have done, by cropping the background out of frame entirely — and a shadow is what stops the result reading as a rectangle pasted onto generated art.

This is the last of the three compositing phases.

## 2. Data model

```sql
alter table category_overlays
  add column shape text not null default 'none'
    check (shape in ('none','circle','rounded')),
  add column border_width_pct numeric not null default 0,
  add column border_color text not null default '',
  add column tint text not null default 'none'
    check (tint in ('none','grayscale','color')),
  add column tint_color text not null default '',
  add column shadow boolean not null default false;
```

**`tint: 'color'`, not `'brand'`.** B1's sketch proposed `brand`, resolving the brand profile's palette at composite time. That is rejected: the compositing path has no brand awareness today, B2 already lengthened it, and coupling image rendering to the brand record buys automatic re-branding of *future* posts only — which a per-overlay colour achieves by editing one field. The colour lives on the overlay.

`border_width_pct` is a percentage of the **layer's own width**, like `size_pct`, so a border looks right on a 15% logo and a 35% headshot alike and survives the app's different aspect ratios.

All six columns default to the current behaviour, so every existing overlay renders exactly as it does today.

## 3. The layer builder — and the one file that finally opens

B1 and B2 both held `lib/athena/overlay-composite.ts` to a zero-byte diff, deliberately. B3 cannot: treatments happen inside its per-layer loop.

Rather than growing the file every generation path depends on, the per-layer build moves out:

```ts
// lib/athena/overlay-layer.ts
buildOverlayLayer(
  raw: Buffer,
  box: { width: number; height: number },
  overlay: CategoryOverlay,
): Promise<{ layer: Buffer; shadow: Buffer | null }>
```

`compositeOverlays` shrinks to an orchestrator: fetch → `computePlacement` → `buildOverlayLayer` → composite shadow, then layer. The opacity handling moves into the builder with the rest of the per-layer work.

## 4. Order of operations is the design

**resize → tint → mask → border → opacity**, with the shadow derived from the **masked** alpha.

This order is not arbitrary, and every step of it is wrong in a specific way if moved:

- **Tint before mask.** Masking first leaves the mask's antialiased edge pixels untinted, producing a faint untreated halo.
- **Border after mask.** Bordering first traces the original rectangle, so a circular mask then cuts the border's corners off.
- **Shadow from the masked silhouette.** Taking it from the unmasked layer casts a rectangular shadow behind a circular photo — the single most visible way to get this wrong, and it looks like a bug rather than a style.
- **Opacity last.** It scales the whole composed layer's alpha, including the border.

Each stage still "works" in isolation under a wrong order; only the composite result reveals it. This is what §7's tests exist to pin.

## 5. The shadow

A boolean, with offset and blur computed as a percentage of the layer's width so nothing needs tuning and nothing can be set to a bad value.

**The shadow buffer is the same dimensions as the layer** — a blurred, darkened copy of its alpha silhouette — composited beneath it at an offset, **clamped to stay inside the base image**. It is deliberately not built on an expanded canvas: `sharp` throws when a composite layer falls outside the base, and that is precisely the failure `computePlacement` already had to be fixed for. Clamping means an overlay flush against the margin gets a slightly clipped shadow instead of a failed ingest.

If the shadow cannot be placed at all, it is skipped and the layer still composites.

## 6. Test Run gets treatments for free

B2's placeholder is substituted as the slot's `image_url` as a `data:` URI and then flows through the ordinary pipeline. It therefore passes through `buildOverlayLayer` like any other layer — **a circular slot previews as a circle, with its border and shadow, with no additional work.**

That makes Test Run genuinely useful here: a treatment can be judged before any real photo exists, which is the point at which it is cheapest to change.

## 7. Testing

The arithmetic and the ordering, per this repo's convention of testing the logic around image work rather than pixels:

- **`treatmentGeometry(box, overlay)`** — a pure function returning the pixel border width, shadow offset and blur radius derived from percentages. Tested across a small and a large layer, at zero border, and at a border wide enough to consume the whole layer (which must clamp rather than invert).
- **The pipeline order** — `buildOverlayLayer` exposes its stage sequence as a pure, inspectable list (`resize`, `tint`, `mask`, `border`, `opacity`) built from the overlay's settings, so a test can assert that tint precedes mask and border follows it without rendering anything. Stages absent from an overlay's configuration are absent from the list.
- **Validation pairings** — `border_width_pct > 0` requires `border_color`; `tint: 'color'` requires `tint_color`; a `tint_color` on `tint: 'none'` is rejected rather than silently ignored.

No live-`sharp` or pixel-comparison tests, consistent with B1 and B2.

## 8. UI

The overlay editor's expanded panel gains a treatments group: a shape select, border width and colour, a tint select and colour, and a shadow switch.

**A caution, not a block.** When `shape !== 'none'` or `tint !== 'none'`, the panel shows: *"Masking or tinting will stop a QR code scanning."* Treatments remain available on every overlay — a logo may well want a soft shadow — but the failure mode is impossible to stumble into unknowingly. This is deliberate: the entire reason this project exists is QR codes that actually scan, and a circular mask destroys one silently.

## 9. Out of scope

- **True two-colour duotone.** Stated out of scope since B1 and unchanged: `tint: color` is grayscale plus one colour — a monotone. A real duotone needs channel remapping.
- **Background removal.** Cut on cost; §1's mask is the mitigation, not a substitute.
- Per-corner radius control, or a configurable radius for `rounded` — one sensible radius derived from the layer's size.
- Configurable shadow offset, blur or colour (§5).
- Treatments on the base image rather than the overlay.
- Animated or video overlays.
- Resolving tint from the brand palette (§2).
