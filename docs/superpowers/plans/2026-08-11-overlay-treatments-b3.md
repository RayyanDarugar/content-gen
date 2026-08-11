# Overlay Treatments (B3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shape masks, borders, tints and drop shadows on composited overlays — so a real headshot reads as part of the design rather than a rectangle pasted onto it.

**Architecture:** The per-layer build moves out of `compositeOverlays` into `lib/athena/overlay-layer.ts`, which applies treatments in a fixed order and returns the layer plus an optional shadow. The arithmetic and the stage ordering are extracted as pure functions and are what the tests pin. See `docs/superpowers/specs/2026-08-11-overlay-treatments-design.md`.

**Tech Stack:** Next.js 16.2.10, Supabase (Postgres + RLS), `sharp` 0.35.3, TypeScript, Vitest, Tailwind + shadcn/ui.

## Global Constraints

- **The stage order is the design: resize → tint → mask → border → opacity, with the shadow derived from the *masked* alpha.** Each step is wrong in a specific, invisible-in-isolation way if moved — mask before tint leaves an untinted antialiased halo; border before mask has its corners cut off; a shadow from the unmasked layer casts a rectangle behind a circular photo.
- **Compositing must never fail an ingest.** By the time it runs, the generation's image has already succeeded and been stored. Every per-layer failure is caught, logged and skipped; `compositeOverlays` must remain incapable of throwing.
- **The shadow buffer is the same dimensions as the layer and is clamped inside the base.** Never built on an expanded canvas — `sharp` throws when a composite layer falls outside the base, which is the exact failure `computePlacement` already had to be fixed for.
- **All six new columns default to today's behaviour**, so every existing overlay renders exactly as it does now.
- **Downstream invariants from B1/B2 still hold:** `generations.public_url` is the clean carousel anchor; `composited_url` is the published artifact; `publishedImageUrl` is the chokepoint. Slots reach compositing as ordinary overlays via `resolveOverlaysForIdea`.
- **Never spread caller-supplied objects into a database payload — enumerate columns.** B2's final review found the entire feature unreachable because a new column was missing from both mutation payloads. **Adding columns means editing `createOverlayForUser` AND `updateOverlayForUser` in `lib/overlay-mutations.ts`.**
- **Next.js 16.2.10.** Per `AGENTS.md`, App Router APIs differ from your training data — read `node_modules/next/dist/docs/` before using one.
- **Migrations are applied manually by the repo owner.** A task that writes one says so and stops.
- Tests are Vitest (`npm run test`), pure-logic only, flat in `tests/<name>.test.ts`. This repo tests the logic *around* image work, never pixel output.
- Commit after every task. Conventional-commit prefixes.

## Out of scope

True two-colour duotone. Background removal. Per-corner radius or a configurable `rounded` radius. Configurable shadow offset/blur/colour. Treatments on the base image. Animated overlays. Resolving tint from the brand palette.

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/0023_overlay_treatments.sql` | **create** — the six treatment columns |
| `lib/types.ts` | **modify** — `OverlayShape`, `OverlayTint`, six `CategoryOverlay` fields |
| `lib/overlays.ts` | **modify** — six `OverlayFields` fields + the validation pairings |
| `lib/overlay-mutations.ts` | **modify** — the six columns in **both** payloads |
| `lib/athena/overlay-treatments.ts` | **create** — `treatmentGeometry`, `treatmentStages` (both pure) |
| `lib/athena/overlay-layer.ts` | **create** — `buildOverlayLayer` (the `sharp` work) |
| `lib/athena/overlay-composite.ts` | **modify** — becomes an orchestrator |
| `app/(app)/config/overlay-section.tsx` | **modify** — the treatments group + the QR caution |

---

## Task 1: Migration, types, validation, and the mutation payloads

**Files:**
- Create: `supabase/migrations/0023_overlay_treatments.sql`
- Modify: `lib/types.ts`, `lib/overlays.ts`, `lib/overlay-mutations.ts`, `app/(app)/config/overlay-section.tsx`
- Test: `tests/overlays.test.ts`

**Interfaces:**
- Consumes: `CategoryOverlay`, `OverlayFields` (B1/B2).
- Produces: `OverlayShape`, `OverlayTint`, and six fields on both `CategoryOverlay` and `OverlayFields`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0023_overlay_treatments.sql`:

```sql
-- supabase/migrations/0023_overlay_treatments.sql
-- Overlay treatments, B3 (spec 2026-08-11-overlay-treatments-design.md).
--
-- Background removal was cut on cost, so an uploaded headshot arrives as a
-- rectangle carrying whatever background it was shot against. A circular mask
-- with a border does most of what a cutout would have — it crops the
-- background out of frame — and a shadow is what stops the result reading as
-- a rectangle pasted onto generated art.
--
-- Every column defaults to today's behaviour, so existing overlays render
-- exactly as they do now.

alter table category_overlays
  add column shape text not null default 'none'
    check (shape in ('none','circle','rounded')),
  -- Percentage of the LAYER's own width, like size_pct, so a border looks
  -- right on a 15% logo and a 35% headshot alike.
  add column border_width_pct numeric not null default 0,
  add column border_color text not null default '',
  -- 'color' rather than B1's proposed 'brand': the compositing path has no
  -- brand awareness, and coupling image rendering to the brand record buys
  -- only automatic re-branding of FUTURE posts, which editing one field
  -- already achieves.
  add column tint text not null default 'none'
    check (tint in ('none','grayscale','color')),
  add column tint_color text not null default '',
  -- A boolean, not a set of knobs: offset and blur are derived from the
  -- layer's width so nothing needs tuning and nothing can be set badly.
  add column shadow boolean not null default false;
```

- [ ] **Step 2: Add the types**

In `lib/types.ts`, above `CategoryOverlay`:

```ts
export type OverlayShape = "none" | "circle" | "rounded";
export type OverlayTint = "none" | "grayscale" | "color";
```

and six fields on `CategoryOverlay`, after `opacity`:

```ts
  opacity: number;
  shape: OverlayShape;
  // Percentage of the layer's own width.
  border_width_pct: number;
  border_color: string;
  tint: OverlayTint;
  tint_color: string;
  shadow: boolean;
```

- [ ] **Step 3: Write the failing validation test**

In `tests/overlays.test.ts`, add the six new fields to the existing `fields()` helper's defaults (`shape: "none", border_width_pct: 0, border_color: "", tint: "none", tint_color: "", shadow: false`), then add:

```ts
describe("validateOverlayFields — treatments", () => {
  it("accepts the default, untreated overlay", () => {
    expect(() => validateOverlayFields(fields())).not.toThrow();
  });

  it("accepts a circular overlay with a border", () => {
    expect(() => validateOverlayFields(
      fields({ shape: "circle", border_width_pct: 4, border_color: "#ff8800" }),
    )).not.toThrow();
  });

  it("rejects an unknown shape", () => {
    expect(() => validateOverlayFields(fields({ shape: "hexagon" as never }))).toThrow(/shape/i);
  });

  it("rejects an unknown tint", () => {
    expect(() => validateOverlayFields(fields({ tint: "sepia" as never }))).toThrow(/tint/i);
  });

  // A border with no colour would render as transparent — visible as nothing,
  // with no error to explain why the setting did nothing.
  it("rejects a border width with no colour", () => {
    expect(() => validateOverlayFields(fields({ border_width_pct: 4 }))).toThrow(/colour|color/i);
  });

  it("rejects a border wider than a quarter of the layer", () => {
    expect(() => validateOverlayFields(
      fields({ border_width_pct: 26, border_color: "#ffffff" }),
    )).toThrow(/border/i);
  });

  it("rejects tint: color with no colour", () => {
    expect(() => validateOverlayFields(fields({ tint: "color" }))).toThrow(/colour|color/i);
  });

  // Silently ignoring it would leave a colour on screen that does nothing.
  it("rejects a tint colour when the tint is not 'color'", () => {
    expect(() => validateOverlayFields(
      fields({ tint: "grayscale", tint_color: "#ff8800" }),
    )).toThrow(/tint/i);
  });

  it("rejects a malformed hex colour", () => {
    expect(() => validateOverlayFields(
      fields({ border_width_pct: 4, border_color: "orange" }),
    )).toThrow(/hex/i);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/overlays.test.ts`
Expected: FAIL — the six fields are not on `OverlayFields` and none of the rules exist.

- [ ] **Step 5: Implement the validation**

In `lib/overlays.ts`, add the six fields to `OverlayFields` (typed `OverlayShape` / `OverlayTint` / `number` / `string` / `boolean`), import both types, and add after the existing `opacity` check:

```ts
const SHAPES = new Set<string>(["none", "circle", "rounded"]);
const TINTS = new Set<string>(["none", "grayscale", "color"]);
const HEX = /^#[0-9a-fA-F]{6}$/;
```

```ts
  if (!SHAPES.has(f.shape)) throw new Error(`Unknown shape "${f.shape}"`);
  if (!TINTS.has(f.tint)) throw new Error(`Unknown tint "${f.tint}"`);

  // A border with no colour renders transparent — the setting appears to do
  // nothing, with nothing on screen explaining why.
  if (f.border_width_pct < 0) throw new Error("Border width cannot be negative");
  if (f.border_width_pct > 25) throw new Error("Border must be 25 percent of the layer or less");
  if (f.border_width_pct > 0) {
    if (!f.border_color.trim()) throw new Error("Pick a border colour");
    if (!HEX.test(f.border_color.trim())) throw new Error("Border colour must be a hex value like #ff8800");
  }

  if (f.tint === "color") {
    if (!f.tint_color.trim()) throw new Error("Pick a tint colour");
    if (!HEX.test(f.tint_color.trim())) throw new Error("Tint colour must be a hex value like #ff8800");
  } else if (f.tint_color.trim()) {
    // Rejected rather than ignored: a colour sitting in the form doing
    // nothing is worse than being told it does not apply.
    throw new Error("Clear the tint colour, or set the tint to a colour tint");
  }
```

- [ ] **Step 6: Add the columns to BOTH mutation payloads**

**This step is the one B2 got wrong and shipped an unreachable feature over.** `lib/overlay-mutations.ts` enumerates columns explicitly (deliberately — see its comment). Add all six to the payload in `createOverlayForUser` **and** the payload in `updateOverlayForUser`:

```ts
    shape: fields.shape,
    border_width_pct: fields.border_width_pct,
    border_color: fields.border_color,
    tint: fields.tint,
    tint_color: fields.tint_color,
    shadow: fields.shadow,
```

- [ ] **Step 7: Fix the compile errors and verify**

Run: `npx tsc --noEmit && npx vitest run`

`tsc` will fail at every site constructing an `OverlayFields` or a complete `CategoryOverlay` — at minimum `app/(app)/config/overlay-section.tsx`'s draft defaults and its `toFields()`, and the fixtures in `tests/overlay-slots.test.ts`, `tests/overlay-composite.test.ts` and `tests/overlay-placeholder.test.ts`. Add the six defaults (`shape: "none", border_width_pct: 0, border_color: "", tint: "none", tint_color: "", shadow: false`) at each. **Do not make the fields optional** to avoid touching them.

No treatments UI in this task — that is Task 4.

- [ ] **Step 8: Run the full suite and commit**

Run: `npx vitest run && npm run build`

```bash
git add supabase/migrations/0023_overlay_treatments.sql lib/types.ts lib/overlays.ts lib/overlay-mutations.ts tests/overlays.test.ts tests/overlay-slots.test.ts tests/overlay-composite.test.ts tests/overlay-placeholder.test.ts "app/(app)/config/overlay-section.tsx"
git commit -m "feat: treatment columns on category_overlays"
```

- [ ] **Step 9: Apply the migration**

**STOP.** Migrations are applied manually. Tell the repo owner: "0023 is ready — apply it to Supabase." It is purely additive with defaults matching current behaviour, so there is no deploy-ordering hazard.

---

## Task 2: The pure treatment logic

**Files:**
- Create: `lib/athena/overlay-treatments.ts`
- Test: `tests/overlay-treatments.test.ts`

**Interfaces:**
- Consumes: `CategoryOverlay`, `OverlayShape`, `OverlayTint` (Task 1).
- Produces:
  - `interface TreatmentGeometry { borderPx: number; shadowOffsetPx: number; shadowBlurPx: number; cornerRadiusPx: number }`
  - `treatmentGeometry(box: { width: number; height: number }, o: Pick<CategoryOverlay, "border_width_pct" | "shape">): TreatmentGeometry`
  - `type TreatmentStage = "resize" | "tint" | "mask" | "border" | "opacity"`
  - `treatmentStages(o: Pick<CategoryOverlay, "tint" | "shape" | "border_width_pct" | "opacity">): TreatmentStage[]`

`treatmentStages` exists so the ordering — which the spec calls the actual design — can be asserted without rendering anything.

- [ ] **Step 1: Write the failing test**

Create `tests/overlay-treatments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { treatmentGeometry, treatmentStages } from "@/lib/athena/overlay-treatments";

describe("treatmentGeometry", () => {
  it("derives the border from a percentage of the layer's width", () => {
    const g = treatmentGeometry({ width: 400, height: 400 }, { border_width_pct: 5, shape: "none" });
    expect(g.borderPx).toBe(20);
  });

  it("is zero when no border is configured", () => {
    const g = treatmentGeometry({ width: 400, height: 400 }, { border_width_pct: 0, shape: "none" });
    expect(g.borderPx).toBe(0);
  });

  // A border thicker than half the shorter side would consume the layer and
  // invert into a solid rectangle.
  it("clamps a border that would consume the layer", () => {
    const g = treatmentGeometry({ width: 100, height: 40 }, { border_width_pct: 25, shape: "none" });
    expect(g.borderPx * 2).toBeLessThan(40);
  });

  it("scales the shadow with the layer, not with a fixed pixel size", () => {
    const small = treatmentGeometry({ width: 100, height: 100 }, { border_width_pct: 0, shape: "none" });
    const large = treatmentGeometry({ width: 1000, height: 1000 }, { border_width_pct: 0, shape: "none" });
    expect(large.shadowOffsetPx).toBeGreaterThan(small.shadowOffsetPx);
    expect(large.shadowBlurPx).toBeGreaterThan(small.shadowBlurPx);
  });

  it("never produces a zero shadow offset or blur", () => {
    const g = treatmentGeometry({ width: 10, height: 10 }, { border_width_pct: 0, shape: "none" });
    expect(g.shadowOffsetPx).toBeGreaterThanOrEqual(1);
    expect(g.shadowBlurPx).toBeGreaterThanOrEqual(1);
  });

  it("gives a corner radius only for the rounded shape", () => {
    const box = { width: 400, height: 200 };
    expect(treatmentGeometry(box, { border_width_pct: 0, shape: "rounded" }).cornerRadiusPx).toBeGreaterThan(0);
    expect(treatmentGeometry(box, { border_width_pct: 0, shape: "circle" }).cornerRadiusPx).toBe(0);
    expect(treatmentGeometry(box, { border_width_pct: 0, shape: "none" }).cornerRadiusPx).toBe(0);
  });

  // The radius keys off the SHORTER side: 12% of a wide layer's width would
  // exceed half its height and produce a malformed shape.
  it("derives the corner radius from the shorter side", () => {
    const wide = treatmentGeometry({ width: 1000, height: 100 }, { border_width_pct: 0, shape: "rounded" });
    expect(wide.cornerRadiusPx * 2).toBeLessThanOrEqual(100);
  });
});

describe("treatmentStages", () => {
  const plain = { tint: "none" as const, shape: "none" as const, border_width_pct: 0, opacity: 100 };

  it("is resize alone for an untreated overlay", () => {
    expect(treatmentStages(plain)).toEqual(["resize"]);
  });

  // Mask before tint leaves the mask's antialiased edge pixels untinted — a
  // faint untreated halo around the shape.
  it("tints before masking", () => {
    const s = treatmentStages({ ...plain, tint: "grayscale", shape: "circle" });
    expect(s.indexOf("tint")).toBeLessThan(s.indexOf("mask"));
  });

  // Bordering before masking traces the original rectangle, so the mask then
  // cuts the border's corners off.
  it("borders after masking", () => {
    const s = treatmentStages({ ...plain, shape: "circle", border_width_pct: 4 });
    expect(s.indexOf("border")).toBeGreaterThan(s.indexOf("mask"));
  });

  it("applies opacity last of all", () => {
    const s = treatmentStages({ tint: "color", shape: "rounded", border_width_pct: 4, opacity: 50 });
    expect(s).toEqual(["resize", "tint", "mask", "border", "opacity"]);
  });

  it("omits stages the overlay does not configure", () => {
    expect(treatmentStages({ ...plain, tint: "grayscale" })).toEqual(["resize", "tint"]);
    expect(treatmentStages({ ...plain, opacity: 40 })).toEqual(["resize", "opacity"]);
  });

  it("always starts with resize", () => {
    expect(treatmentStages({ tint: "color", shape: "circle", border_width_pct: 9, opacity: 10 })[0]).toBe("resize");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/overlay-treatments.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/overlay-treatments`.

- [ ] **Step 3: Write the implementation**

Create `lib/athena/overlay-treatments.ts`:

```ts
import type { CategoryOverlay } from "@/lib/types";

// Pure, and no server-only import: the ordering and the arithmetic are the
// parts of B3 worth testing, and they are only testable because no sharp call
// sits beside them — the same separation that makes computePlacement testable.

// Derived from the layer's own width so a shadow looks right on a 15% logo
// and a 35% headshot alike, and across this app's 4:5 and 1:1 canvases.
const SHADOW_OFFSET_PCT = 2;
const SHADOW_BLUR_PCT = 3;
// Of the SHORTER side — 12% of a wide layer's width would exceed half its
// height and produce a malformed shape.
const ROUNDED_RADIUS_PCT = 12;

export interface TreatmentGeometry {
  borderPx: number;
  shadowOffsetPx: number;
  shadowBlurPx: number;
  cornerRadiusPx: number;
}

export function treatmentGeometry(
  box: { width: number; height: number },
  o: Pick<CategoryOverlay, "border_width_pct" | "shape">,
): TreatmentGeometry {
  const shorter = Math.min(box.width, box.height);

  // A border thicker than half the shorter side consumes the layer entirely
  // and inverts into a solid rectangle. Clamp rather than render that.
  const maxBorder = Math.max(0, Math.floor((shorter - 1) / 2));
  const borderPx = Math.min(
    Math.max(0, Math.round((box.width * o.border_width_pct) / 100)),
    maxBorder,
  );

  return {
    borderPx,
    shadowOffsetPx: Math.max(1, Math.round((box.width * SHADOW_OFFSET_PCT) / 100)),
    shadowBlurPx: Math.max(1, Math.round((box.width * SHADOW_BLUR_PCT) / 100)),
    cornerRadiusPx:
      o.shape === "rounded"
        ? Math.max(1, Math.round((shorter * ROUNDED_RADIUS_PCT) / 100))
        : 0,
  };
}

export type TreatmentStage = "resize" | "tint" | "mask" | "border" | "opacity";

// The stage order IS the design (spec §4), and each step is wrong in a
// specific, invisible-in-isolation way if moved. Exposing it as a list lets a
// test assert the ordering without rendering anything.
export function treatmentStages(
  o: Pick<CategoryOverlay, "tint" | "shape" | "border_width_pct" | "opacity">,
): TreatmentStage[] {
  const stages: TreatmentStage[] = ["resize"];
  if (o.tint !== "none") stages.push("tint");
  if (o.shape !== "none") stages.push("mask");
  if (o.border_width_pct > 0) stages.push("border");
  if (o.opacity < 100) stages.push("opacity");
  return stages;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/overlay-treatments.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/overlay-treatments.ts tests/overlay-treatments.test.ts
git commit -m "feat: treatment geometry and stage ordering"
```

---

## Task 3: The layer builder, and `compositeOverlays` becomes an orchestrator

**Files:**
- Create: `lib/athena/overlay-layer.ts`
- Modify: `lib/athena/overlay-composite.ts`

**Interfaces:**
- Consumes: `treatmentGeometry`, `treatmentStages` (Task 2); `computePlacement` (B1).
- Produces: `buildOverlayLayer(raw: Buffer, box: { width: number; height: number }, o: CategoryOverlay): Promise<{ layer: Buffer; shadow: Buffer | null }>`

**This is the first change to `lib/athena/overlay-composite.ts` in three projects.** B1 and B2 both held it to a zero-byte diff. It opens once, structurally: the per-layer work leaves, and what remains is fetch → place → build → composite.

- [ ] **Step 1: Write the layer builder**

Create `lib/athena/overlay-layer.ts`:

```ts
import "server-only";
import sharp from "sharp";
import { treatmentGeometry } from "@/lib/athena/overlay-treatments";
import type { CategoryOverlay } from "@/lib/types";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.trim().replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// The mask shape, as an SVG the size of the layer. White where the layer
// should survive; compositing it with dest-in multiplies the layer's alpha by
// this, so anything outside the shape becomes transparent.
function maskSvg(w: number, h: number, o: CategoryOverlay, radius: number): Buffer {
  const body =
    o.shape === "circle"
      ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#fff"/>`
      : `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/>`;
  return Buffer.from(`<svg width="${w}" height="${h}">${body}</svg>`);
}

// The border traces the MASK's shape, drawn inset by half its width so the
// stroke sits fully inside the layer rather than being clipped in half.
function borderSvg(w: number, h: number, o: CategoryOverlay, radius: number, px: number): Buffer {
  const i = px / 2;
  const body =
    o.shape === "circle"
      ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2 - i}" ry="${h / 2 - i}" fill="none" stroke="${o.border_color}" stroke-width="${px}"/>`
      : `<rect x="${i}" y="${i}" width="${w - px}" height="${h - px}" rx="${Math.max(0, radius - i)}" ry="${Math.max(0, radius - i)}" fill="none" stroke="${o.border_color}" stroke-width="${px}"/>`;
  return Buffer.from(`<svg width="${w}" height="${h}">${body}</svg>`);
}

// Applies treatments in the one order that is correct (spec §4):
// resize -> tint -> mask -> border -> opacity, with the shadow taken from the
// MASKED alpha so a circular photo casts a circular shadow.
//
// Returns the layer plus an optional shadow of identical dimensions. The
// shadow is deliberately NOT built on an expanded canvas: sharp throws when a
// composite layer falls outside the base, and the caller clamps this one
// inside instead.
export async function buildOverlayLayer(
  raw: Buffer,
  box: { width: number; height: number },
  o: CategoryOverlay,
): Promise<{ layer: Buffer; shadow: Buffer | null }> {
  const g = treatmentGeometry(box, o);
  const { width, height } = box;

  // resize
  let buf = await sharp(raw).resize(width, height, { fit: "fill" }).ensureAlpha().png().toBuffer();

  // tint — before the mask, or the mask's antialiased edge keeps untinted pixels
  if (o.tint === "grayscale") {
    buf = await sharp(buf).grayscale().png().toBuffer();
  } else if (o.tint === "color") {
    buf = await sharp(buf).grayscale().tint(hexToRgb(o.tint_color)).png().toBuffer();
  }

  // mask
  if (o.shape !== "none") {
    buf = await sharp(buf)
      .composite([{ input: maskSvg(width, height, o, g.cornerRadiusPx), blend: "dest-in" }])
      .png()
      .toBuffer();
  }

  // shadow — from the MASKED alpha, so the silhouette matches the shape
  let shadow: Buffer | null = null;
  if (o.shadow) {
    const alpha = await sharp(buf).extractChannel("alpha").blur(g.shadowBlurPx).png().toBuffer();
    shadow = await sharp({
      create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.45 } },
    })
      .composite([{ input: alpha, blend: "dest-in" }])
      .png()
      .toBuffer();
  }

  // border — after the mask, so it traces the shape rather than the rectangle
  if (g.borderPx > 0) {
    buf = await sharp(buf)
      .composite([{ input: borderSvg(width, height, o, g.cornerRadiusPx, g.borderPx) }])
      .png()
      .toBuffer();
  }

  // opacity — last, scaling the whole composed layer including its border
  if (o.opacity < 100) {
    buf = await sharp(buf)
      .composite([{
        input: {
          create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: o.opacity / 100 } },
        },
        blend: "dest-in",
      }])
      .png()
      .toBuffer();
  }

  return { layer: buf, shadow };
}
```

- [ ] **Step 2: Verify the two uncertain `sharp` recipes**

Two things here cannot be confirmed from documentation: whether an SVG buffer composites with `dest-in` as a mask, and whether `extractChannel("alpha")` output composites back as a mask. Verify both with a throwaway script (**do not commit it**):

```bash
node -e "
const sharp = require('sharp');
(async () => {
  const W = 100;
  const layer = await sharp({create:{width:W,height:W,channels:4,background:{r:0,g:0,b:255,alpha:1}}}).png().toBuffer();
  const mask = Buffer.from('<svg width=\"'+W+'\" height=\"'+W+'\"><ellipse cx=\"50\" cy=\"50\" rx=\"50\" ry=\"50\" fill=\"#fff\"/></svg>');
  const masked = await sharp(layer).composite([{input:mask,blend:'dest-in'}]).png().toBuffer();
  const px = await sharp(masked).raw().toBuffer();
  // corner (0,0) is outside the ellipse -> alpha 0; centre -> alpha 255
  console.log('corner alpha (expect 0):', px[3]);
  const c = ((50*W)+50)*4;
  console.log('centre alpha (expect 255):', px[c+3]);
  const alpha = await sharp(masked).extractChannel('alpha').blur(3).png().toBuffer();
  const shadow = await sharp({create:{width:W,height:W,channels:4,background:{r:0,g:0,b:0,alpha:0.45}}})
    .composite([{input:alpha,blend:'dest-in'}]).png().toBuffer();
  const sp = await sharp(shadow).raw().toBuffer();
  console.log('shadow corner alpha (expect ~0):', sp[3], 'shadow centre alpha (expect >0):', sp[c+3]);
})();
"
```

**If the mask recipe fails**, stop and report — the shape mask is the core of B3 and guessing at a substitute is worse than escalating.

**If only the shadow recipe fails**, drop the shadow (`return { layer: buf, shadow: null }` unconditionally) and say so prominently: Task 4 must then omit the shadow switch rather than ship a control that does nothing. The mask is what does the real work; the shadow is the least essential of the three.

Report the actual observed numbers either way. "It worked" without numbers is not evidence.

- [ ] **Step 3: Turn `compositeOverlays` into an orchestrator**

In `lib/athena/overlay-composite.ts`, add the imports:

```ts
import { buildOverlayLayer } from "@/lib/athena/overlay-layer";
import { treatmentGeometry } from "@/lib/athena/overlay-treatments";
```

and replace the whole per-layer block — from `let layer = sharp(raw)...` through the `.jpeg({ quality: 90 }).toBuffer();` composite — with:

```ts
      // The per-layer build (resize, treatments, opacity) lives in
      // lib/athena/overlay-layer.ts. This function stays an orchestrator:
      // fetch, place, build, composite.
      const { layer, shadow } = await buildOverlayLayer(raw, { width: p.width, height: p.height }, o);

      const parts: sharp.OverlayOptions[] = [];
      if (shadow) {
        // Clamped inside the base rather than expanding the canvas: sharp
        // throws when a composite layer falls outside, which is exactly the
        // failure computePlacement already had to be fixed for. An overlay
        // flush against the margin gets a slightly clipped shadow instead of
        // a failed ingest.
        const g = treatmentGeometry({ width: p.width, height: p.height }, o);
        parts.push({
          input: shadow,
          left: Math.min(Math.max(0, p.left + g.shadowOffsetPx), Math.max(0, meta.width - p.width)),
          top: Math.min(Math.max(0, p.top + g.shadowOffsetPx), Math.max(0, meta.height - p.height)),
        });
      }
      parts.push({ input: layer, left: p.left, top: p.top });

      current = await sharp(current)
        .composite(parts)
        // Match the clean image's encode (quality: 90) — sharp defaults JPEG
        // output to 80, so the published image would end up softer than the
        // one nobody sees.
        .jpeg({ quality: 90 })
        .toBuffer();
      composited++;
```

Everything else in that function — `overlaysForRole`, the guarded `metadata()` read, the per-layer try/catch, the `composited > 0 ? current : null` return — is unchanged. `sharp` is still imported and still used.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS. `tests/overlay-composite.test.ts` covers `overlaysForRole` only, which is untouched, so it must still pass unmodified.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/overlay-layer.ts lib/athena/overlay-composite.ts
git commit -m "feat: apply treatments when building an overlay layer"
```

---

## Task 4: The treatments group in the overlay editor

**Files:**
- Modify: `app/(app)/config/overlay-section.tsx`

**Interfaces:**
- Consumes: `OverlayShape`, `OverlayTint`, `OverlayFields` (Task 1).
- Produces: nothing new.

`OverlayEditor`'s expanded panel already carries name, image, role chips, corner, margin/size/opacity, sort order and active, in the layout the human chose from mockups. Treatments are a new group beneath those, not a redesign.

- [ ] **Step 1: Add the treatments group**

In the expanded panel, after the existing numeric row and before Save/Delete, add:

```tsx
<div className="space-y-2 rounded-lg border border-dashed p-2">
  <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
    Treatment
  </p>

  {(form.shape !== "none" || form.tint !== "none") && (
    <p className="text-[11px] text-amber-700">
      Masking or tinting will stop a QR code scanning.
    </p>
  )}

  <div className="grid grid-cols-2 gap-2">
    <div className="flex flex-col gap-1">
      <Label className="text-[10px]">Shape</Label>
      <select
        className="rounded-md border px-2 py-1 text-xs"
        value={form.shape}
        onChange={(e) => set("shape", e.target.value as OverlayShape)}
      >
        <option value="none">Square</option>
        <option value="circle">Circle</option>
        <option value="rounded">Rounded</option>
      </select>
    </div>
    <div className="flex flex-col gap-1">
      <Label className="text-[10px]">Tint</Label>
      <select
        className="rounded-md border px-2 py-1 text-xs"
        value={form.tint}
        onChange={(e) => {
          const tint = e.target.value as OverlayTint;
          // The validator rejects a tint colour on a non-colour tint, so
          // clearing it here keeps the form saveable rather than erroring
          // about a field the user can no longer see.
          set("tint", tint);
          if (tint !== "color") set("tint_color", "");
        }}
      >
        <option value="none">None</option>
        <option value="grayscale">Grayscale</option>
        <option value="color">Colour</option>
      </select>
    </div>
  </div>

  <div className="grid grid-cols-3 gap-2">
    <div className="flex flex-col gap-1">
      <Label className="text-[10px]">Border %</Label>
      <Input
        type="number" className="h-7 text-xs" value={form.border_width_pct}
        onChange={(e) => set("border_width_pct", Number(e.target.value))}
      />
    </div>
    <div className="flex flex-col gap-1">
      <Label className="text-[10px]">Border colour</Label>
      <Input
        type="color" className="h-7 p-1"
        value={form.border_color || "#ffffff"}
        onChange={(e) => set("border_color", e.target.value)}
      />
    </div>
    {form.tint === "color" && (
      <div className="flex flex-col gap-1">
        <Label className="text-[10px]">Tint colour</Label>
        <Input
          type="color" className="h-7 p-1"
          value={form.tint_color || "#ffffff"}
          onChange={(e) => set("tint_color", e.target.value)}
        />
      </div>
    )}
  </div>

  <div className="flex items-center gap-2">
    <Switch checked={form.shadow} onCheckedChange={(v) => set("shadow", v)} />
    <Label className="text-[10px]">Drop shadow</Label>
  </div>
</div>
```

Import `OverlayShape` and `OverlayTint` from `@/lib/types`. Use whatever setter the component already has for form fields (`set(...)` above stands for it) and whatever `Switch`'s existing `onCheckedChange` signature is in this file — **read the component first and match it** rather than assuming.

**If Task 3's verification found the shadow recipe unworkable, omit the shadow switch entirely** rather than shipping a control that does nothing.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS. Do not start a long-running dev server; report what you could not verify without a browser.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/config/overlay-section.tsx"
git commit -m "feat: treatment controls in the overlay editor"
```
