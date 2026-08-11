# Asset Compositing B1 (Fixed Overlays) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Composite configured overlay images — a logo, a QR code — onto generated slides after generation, so exact assets appear on published posts without ever entering the model's visual reference.

**Architecture:** A generation grows a second artifact. `generations.public_url` keeps its current meaning — the clean image Kie receives as the carousel anchor — and a new `composited_url` holds the published image. One helper, `publishedImageUrl`, is the chokepoint every display and posting path goes through. See `docs/superpowers/specs/2026-08-10-asset-compositing-design.md`.

**Tech Stack:** Next.js 16.2.10 (App Router, server actions), Supabase (Postgres + RLS), `sharp` 0.35.3, Cloudinary, TypeScript, Vitest, Tailwind + shadcn/ui.

## Global Constraints

- **The model only ever sees clean images; humans and Buffer only ever see finished ones.** A generation path reading `composited_url` is a defect. A publish or display path reading `public_url` directly is a defect. The two generation paths that must keep reading `public_url` are `app/api/jobs/poll/route.ts:385` (`sweepOrphanedAnchors`) and `lib/athena/resubmit-slide.ts:99` (single-slide retry).
- **Compositing must never fail an ingest.** A generation whose image succeeded must not be lost because a logo URL 404'd or `sharp` threw. Every compositing failure is logged and skipped.
- **Style-reference generation must never composite.** A brand reference image is a template asset, not a published post. `lib/style-ref-client.ts:71`'s `pollTask` call (inside `generateStyleRef`) must not pass compositing parameters.
- **Next.js 16.2.10.** Per `AGENTS.md`, App Router APIs differ from your training data — read `node_modules/next/dist/docs/` before using one you are unsure about.
- **`"use server"` files publish every export as a POST-reachable endpoint.** Never export a `userId`-taking function from one; the `*ForUser` cores live in plain `lib/` modules (convention documented at `lib/category-mutations.ts:6-18`).
- **Every Supabase query filtered by id must also filter by the tenant** when using the service-role admin client (`createAdminSupabase`), which bypasses RLS. The anon-key session client (`createServerSupabase`) gets the tenant predicate from RLS.
- **Migrations are applied manually by the repo owner.** A task that writes one says so and stops.
- Tests are Vitest (`npm run test`), pure-logic only, flat in `tests/<name>.test.ts`. This repo tests the logic *around* image work, never pixel output.
- Commit after every task. Conventional-commit prefixes.

## Out of scope for B1

Per-idea slots (`slot_key`, `idea_overlay_fills`), treatments (`shape`, `border_*`, `tint*`, `shadow`), and background removal. Do not add those columns — dead columns invite dead code. Do not retro-composite existing posts when overlay config changes.

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/0021_category_overlays.sql` | **create** — `category_overlays` table + RLS + trigger; `generations.composited_url` |
| `lib/types.ts` | **modify** — `CategoryOverlay`, `OverlayCorner`; `Generation.composited_url` |
| `lib/athena/published-image.ts` | **create** — the `publishedImageUrl` chokepoint |
| `lib/athena/overlay-placement.ts` | **create** — pure placement arithmetic |
| `lib/athena/overlay-composite.ts` | **create** — `sharp` compositing built on the placement module |
| `lib/overlay-mutations.ts` | **create** — `*ForUser` CRUD + `listOverlaysForCategory` |
| `lib/overlays.ts` | **create** — `OverlayFields` + `validateOverlayFields` (pure) |
| `app/(app)/config/overlay-section.tsx` | **create** — the overlay editor UI |
| `app/api/jobs/poll/route.ts` | **modify** — composite into a second artifact after ingest |
| `app/api/categories/draft/preview/route.ts` | **modify** — optional compositing on slide polls |
| `lib/style-ref-client.ts` | **modify** — `pollTask` forwards optional params |

---

## Task 1: Migration and types

**Files:**
- Create: `supabase/migrations/0021_category_overlays.sql`
- Modify: `lib/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `OverlayCorner`, `CategoryOverlay`, and `Generation.composited_url: string`. Every later task depends on all three.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0021_category_overlays.sql`:

```sql
-- supabase/migrations/0021_category_overlays.sql
-- Asset compositing B1 (spec 2026-08-10-asset-compositing-design.md).
--
-- A QR code that actually scans can never come from a generative model, so
-- exact assets are composited onto the finished image instead. Configured per
-- category, alongside role_guides/role_ref_urls, and targeted by role.

create table category_overlays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  name text not null,
  image_url text not null,
  -- any subset of hook/beat/payoff/single; an empty array is rejected at the
  -- validation layer rather than silently compositing nowhere.
  roles text[] not null,
  corner text not null check (corner in ('top-left','top-right','bottom-left','bottom-right','center')),
  margin_pct numeric not null default 5,
  -- overlay WIDTH as a percentage of the base image's width; height follows
  -- from the overlay's own aspect ratio. Percentages so placement survives
  -- this app's different aspect ratios (4:5, 1:1).
  size_pct numeric not null default 15,
  opacity numeric not null default 100,
  -- stacking order when several overlays target the same role
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index category_overlays_category_idx on category_overlays(category_id);

alter table category_overlays enable row level security;
create policy "owner all" on category_overlays for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger category_overlays_updated_at before update on category_overlays
  for each row execute function set_updated_at();

-- The second artifact. generations.public_url keeps its existing meaning —
-- the CLEAN image — because fanOutCarousel/sweepOrphanedAnchors and
-- lib/athena/resubmit-slide.ts all hand it to Kie as the carousel anchor.
-- Compositing in place would burn the overlay into the model's visual
-- reference for every later slide. Empty string, not null, matching
-- public_url's existing convention.
alter table generations add column composited_url text not null default '';
```

- [ ] **Step 2: Add the types**

In `lib/types.ts`, add above `Category`:

```ts
export type OverlayCorner =
  | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";

// An exact asset composited onto finished slides (spec §2). Configured per
// category and targeted by role, the same way role_guides is.
export interface CategoryOverlay {
  id: string;
  user_id: string;
  category_id: string;
  name: string;
  image_url: string;
  roles: Slide["role"][];
  corner: OverlayCorner;
  margin_pct: number;
  size_pct: number;
  opacity: number;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}
```

and add one field to `Generation`, directly after `public_url`:

```ts
  public_url: string;
  // The published artifact — public_url with overlays composited on. Empty
  // when the category has no overlays. Read via publishedImageUrl(), never
  // directly, and never by a generation path.
  composited_url: string;
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. If tsc names a file constructing a complete `Generation` literal, add `composited_url: ""` to that fixture — do not make the field optional.

- [ ] **Step 4: Apply the migration**

**STOP.** Migrations are applied manually. Tell the repo owner: "0021 is ready — apply it to Supabase." Note that unlike 0020 this migration is purely additive, so old code keeps working against the new schema and there is no deploy-ordering hazard.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0021_category_overlays.sql lib/types.ts
git commit -m "feat: category_overlays table and generations.composited_url"
```

---

## Task 2: The publishedImageUrl chokepoint

**Files:**
- Create: `lib/athena/published-image.ts`
- Test: `tests/published-image.test.ts`
- Modify: `app/api/posts/create/route.ts`, `app/(app)/gallery/gallery-card.tsx`, `app/(app)/post/page.tsx`, `app/(app)/post/[ideaId]/page.tsx`, `app/(app)/post/[ideaId]/composer.tsx`

**Interfaces:**
- Consumes: `Generation` (Task 1).
- Produces: `publishedImageUrl(gen: Pick<Generation, "public_url" | "composited_url">): string`

`composited_url` is empty everywhere until Task 5, so this task is behaviour-preserving by construction — every call falls through to `public_url`.

- [ ] **Step 1: Write the failing test**

Create `tests/published-image.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { publishedImageUrl } from "@/lib/athena/published-image";

describe("publishedImageUrl", () => {
  it("prefers the composited artifact when one exists", () => {
    expect(publishedImageUrl({ public_url: "clean.jpg", composited_url: "final.jpg" }))
      .toBe("final.jpg");
  });

  // The common case: no overlays configured, so nothing was composited.
  it("falls back to the clean image when composited_url is empty", () => {
    expect(publishedImageUrl({ public_url: "clean.jpg", composited_url: "" }))
      .toBe("clean.jpg");
  });

  it("returns empty when neither exists, rather than undefined", () => {
    expect(publishedImageUrl({ public_url: "", composited_url: "" })).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/published-image.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/published-image`.

- [ ] **Step 3: Write the helper**

Create `lib/athena/published-image.ts`:

```ts
import type { Generation } from "@/lib/types";

// The single chokepoint between a generation's two image artifacts.
//
// public_url is the CLEAN image. It is what Kie receives as the carousel
// anchor — see sweepOrphanedAnchors (app/api/jobs/poll/route.ts) and
// lib/athena/resubmit-slide.ts — so it must never carry an overlay, or the
// model spends every later slide trying to redraw a smeared QR code.
//
// composited_url is what a human or Buffer should see. Display and posting
// paths go through here; generation paths read public_url directly and
// deliberately do not.
//
// No "server-only" import: this is called from client components too
// (the Post composer).
export function publishedImageUrl(
  gen: Pick<Generation, "public_url" | "composited_url">,
): string {
  return gen.composited_url || gen.public_url;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/published-image.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Switch the posting path**

In `app/api/posts/create/route.ts`, import the helper and change four sites. The guards must test the *published* URL, since that is what gets sent:

`:260` — inside the first ordering/validation loop:
```ts
    if (g.status !== "succeeded" || !publishedImageUrl(g)) throw new Error(`generation ${g.id} has no successful image`);
```

`:275`:
```ts
  const imageUrls = ordered.map((g) => publishedImageUrl(g));
```

`:396` — the second loop's guard, same shape as `:260`:
```ts
    if (g.status !== "succeeded" || !publishedImageUrl(g)) {
```

`:440`:
```ts
  const imageUrls = ordered.map((g) => publishedImageUrl(g));
```

- [ ] **Step 6: Switch the gallery**

In `app/(app)/gallery/gallery-card.tsx`:

`:28-30` in `SlideImage`:
```ts
  const url = publishedImageUrl(gen);
  if (gen.status === "succeeded" && url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={alt} className="h-full w-full object-cover" />;
  }
```

`:209-211` in the superseded-history dialog — bind it once above the JSX and use it in both the guard and the `src`:
```ts
                    {publishedImageUrl(g) && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={publishedImageUrl(g)} alt="" className="h-40 rounded-xl object-cover" />
                    )}
```

- [ ] **Step 7: Switch the post pages and composer**

`app/(app)/post/page.tsx:36`:
```ts
      if (g.status === "succeeded" && publishedImageUrl(g)) urlById.set(g.id, publishedImageUrl(g));
```

`app/(app)/post/[ideaId]/page.tsx:86` and `:111` — same transformation as above, each in its own loop.

`app/(app)/post/[ideaId]/page.tsx:95` — this builds a pool row whose `public_url` field is fed from `slide.publicUrl`, which now carries the published URL. Leave the field name; the value is already correct once `:86`/`:111` are switched.

`app/(app)/post/[ideaId]/composer.tsx:241-243`:
```ts
      const url = publishedImageUrl(g);
      if (g.status !== "succeeded" || !url) continue;
      list.push({ id: g.id, url, created_at: g.created_at });
```

`:259` reads `p.public_url` off the already-built pool rows, not off a `Generation` — leave it.

- [ ] **Step 8: Verify the generation paths were not touched**

Run:
```bash
grep -rn "public_url" app lib --include="*.ts" --include="*.tsx" | grep -v "lib/types.ts" | grep -v "published-image" | grep -v test
```
Expected survivors, and **only** these:
- `app/api/jobs/poll/route.ts:59` (the write) and `:385` (`sweepOrphanedAnchors` anchor)
- `lib/athena/resubmit-slide.ts:99` (retry anchor)
- `lib/athena/carousel.ts:7` (a view-model field name)
- `app/(app)/post/[ideaId]/page.tsx:95` and `composer.tsx:259` (pool-row field, not a `Generation` read)

Any other survivor is a display or posting site that was missed.

- [ ] **Step 9: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/athena/published-image.ts tests/published-image.test.ts app/api/posts/create/route.ts "app/(app)/gallery/gallery-card.tsx" "app/(app)/post/page.tsx" "app/(app)/post/[ideaId]/page.tsx" "app/(app)/post/[ideaId]/composer.tsx"
git commit -m "feat: published images resolve through one chokepoint"
```

---

## Task 3: Placement arithmetic

**Files:**
- Create: `lib/athena/overlay-placement.ts`
- Test: `tests/overlay-placement.test.ts`

**Interfaces:**
- Consumes: `OverlayCorner` (Task 1).
- Produces:
  - `interface Placement { left: number; top: number; width: number; height: number }`
  - `computePlacement(base: {width: number; height: number}, overlay: {width: number; height: number}, o: {corner: OverlayCorner; margin_pct: number; size_pct: number}): Placement`

Pure and separate from the `sharp` module so it is testable without image I/O — this is the piece the spec says gets real tests.

- [ ] **Step 1: Write the failing test**

Create `tests/overlay-placement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computePlacement } from "@/lib/athena/overlay-placement";

// 4:5 — this app's default aspect ratio.
const BASE = { width: 1000, height: 1250 };
const SQUARE = { width: 100, height: 100 };

describe("computePlacement", () => {
  it("sizes the overlay from the base's WIDTH, preserving its aspect ratio", () => {
    const p = computePlacement(BASE, { width: 200, height: 100 }, {
      corner: "top-left", margin_pct: 0, size_pct: 20,
    });
    expect(p.width).toBe(200);   // 20% of 1000
    expect(p.height).toBe(100);  // half of width, matching the 2:1 overlay
  });

  it("places top-left at the margin", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "top-left", margin_pct: 5, size_pct: 10 });
    expect({ left: p.left, top: p.top }).toEqual({ left: 50, top: 62 }); // 5% of 1000 / of 1250
  });

  it("places top-right against the right edge", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "top-right", margin_pct: 5, size_pct: 10 });
    expect(p.left).toBe(1000 - 100 - 50);
    expect(p.top).toBe(62);
  });

  it("places bottom-left against the bottom edge", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "bottom-left", margin_pct: 5, size_pct: 10 });
    expect(p.left).toBe(50);
    expect(p.top).toBe(1250 - 100 - 62);
  });

  it("places bottom-right against both far edges", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "bottom-right", margin_pct: 5, size_pct: 10 });
    expect(p.left).toBe(1000 - 100 - 50);
    expect(p.top).toBe(1250 - 100 - 62);
  });

  it("centres regardless of margin", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "center", margin_pct: 20, size_pct: 10 });
    expect(p.left).toBe(450);
    expect(p.top).toBe(575);
  });

  it("puts the overlay flush against the edge at margin 0", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "bottom-right", margin_pct: 0, size_pct: 10 });
    expect(p.left).toBe(900);
    expect(p.top).toBe(1150);
  });

  // sharp throws if a composite layer falls outside the base image, which a
  // badly configured overlay can cause. Clamping means one bad logo cannot
  // fail an entire ingest.
  it("clamps an overlay too large for its margin back inside the base", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "bottom-right", margin_pct: 40, size_pct: 100 });
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.left + p.width).toBeLessThanOrEqual(BASE.width);
    expect(p.top + p.height).toBeLessThanOrEqual(BASE.height);
  });

  it("never produces a zero-width layer", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "center", margin_pct: 0, size_pct: 0.01 });
    expect(p.width).toBeGreaterThanOrEqual(1);
    expect(p.height).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/overlay-placement.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/overlay-placement`.

- [ ] **Step 3: Write the implementation**

Create `lib/athena/overlay-placement.ts`:

```ts
import type { OverlayCorner } from "@/lib/types";

export interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Pure, and deliberately separate from the sharp module: placement is the
// part worth testing, and it can only be tested if no image I/O sits next to
// it. Percentages are resolved against the base image's REAL pixel
// dimensions, so one configuration works across 4:5 and 1:1.
//
// size_pct keys off width only; height follows from the overlay's own aspect
// ratio, so a wide logo and a square QR code both stay undistorted.
// margin_pct resolves against each axis separately, so a 5% inset looks even
// on a non-square canvas.
export function computePlacement(
  base: { width: number; height: number },
  overlay: { width: number; height: number },
  o: { corner: OverlayCorner; margin_pct: number; size_pct: number },
): Placement {
  const width = Math.max(1, Math.round((base.width * o.size_pct) / 100));
  const height = Math.max(1, Math.round(width * (overlay.height / overlay.width)));
  const mx = Math.round((base.width * o.margin_pct) / 100);
  const my = Math.round((base.height * o.margin_pct) / 100);

  let left: number;
  let top: number;
  switch (o.corner) {
    case "top-left":
      left = mx; top = my; break;
    case "top-right":
      left = base.width - width - mx; top = my; break;
    case "bottom-left":
      left = mx; top = base.height - height - my; break;
    case "bottom-right":
      left = base.width - width - mx; top = base.height - height - my; break;
    case "center":
      left = Math.round((base.width - width) / 2);
      top = Math.round((base.height - height) / 2);
      break;
  }

  // sharp throws if a composite layer extends past the base, which an
  // oversized size_pct or a large margin can produce. Clamping keeps one
  // badly configured overlay from failing a whole ingest.
  return {
    width,
    height,
    left: Math.min(Math.max(0, left), Math.max(0, base.width - width)),
    top: Math.min(Math.max(0, top), Math.max(0, base.height - height)),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/overlay-placement.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/overlay-placement.ts tests/overlay-placement.test.ts
git commit -m "feat: percentage-based overlay placement arithmetic"
```

---

## Task 4: Overlay selection and compositing

**Files:**
- Create: `lib/athena/overlay-composite.ts`
- Test: `tests/overlay-composite.test.ts`

**Interfaces:**
- Consumes: `computePlacement`, `Placement` (Task 3); `CategoryOverlay` (Task 1).
- Produces:
  - `overlaysForRole(overlays: CategoryOverlay[], role: Slide["role"]): CategoryOverlay[]`
  - `compositeOverlays(base: Buffer, overlays: CategoryOverlay[], role: Slide["role"]): Promise<Buffer | null>`

`compositeOverlays` returns **null** when nothing was composited — the caller then skips the second upload entirely. Only `overlaysForRole` is unit-tested; the `sharp` path is not, per this repo's convention.

- [ ] **Step 1: Write the failing test**

Create `tests/overlay-composite.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { overlaysForRole } from "@/lib/athena/overlay-composite";
import type { CategoryOverlay } from "@/lib/types";

function ov(over: Partial<CategoryOverlay>): CategoryOverlay {
  return {
    id: "o1", user_id: "u1", category_id: "c1", name: "Logo",
    image_url: "https://example.test/logo.png",
    roles: ["single"], corner: "bottom-right",
    margin_pct: 5, size_pct: 15, opacity: 100, sort_order: 0, active: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("overlaysForRole", () => {
  it("keeps only overlays targeting the slide's role", () => {
    const list = [ov({ id: "a", roles: ["hook"] }), ov({ id: "b", roles: ["payoff"] })];
    expect(overlaysForRole(list, "payoff").map((o) => o.id)).toEqual(["b"]);
  });

  it("keeps an overlay that targets several roles", () => {
    const list = [ov({ id: "a", roles: ["hook", "payoff"] })];
    expect(overlaysForRole(list, "hook").map((o) => o.id)).toEqual(["a"]);
    expect(overlaysForRole(list, "payoff").map((o) => o.id)).toEqual(["a"]);
  });

  it("drops inactive overlays even when the role matches", () => {
    const list = [ov({ id: "a", roles: ["single"], active: false })];
    expect(overlaysForRole(list, "single")).toEqual([]);
  });

  // Several overlays on one slide — a logo AND a QR code — stack in sort_order.
  it("orders matches by sort_order, lowest first", () => {
    const list = [
      ov({ id: "qr", roles: ["payoff"], sort_order: 2 }),
      ov({ id: "logo", roles: ["payoff"], sort_order: 1 }),
    ];
    expect(overlaysForRole(list, "payoff").map((o) => o.id)).toEqual(["logo", "qr"]);
  });

  it("returns empty for a role with no overlays — the common case today", () => {
    expect(overlaysForRole([ov({ roles: ["hook"] })], "beat")).toEqual([]);
  });

  it("does not mutate the input array's order", () => {
    const list = [ov({ id: "b", roles: ["single"], sort_order: 2 }), ov({ id: "a", roles: ["single"], sort_order: 1 })];
    overlaysForRole(list, "single");
    expect(list.map((o) => o.id)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/overlay-composite.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/overlay-composite`.

- [ ] **Step 3: Write the implementation**

Create `lib/athena/overlay-composite.ts`:

```ts
import "server-only";
import sharp from "sharp";
import { computePlacement } from "@/lib/athena/overlay-placement";
import type { CategoryOverlay, Slide } from "@/lib/types";

// Pure — exported separately so the selection rule is testable without any
// image I/O. Sorts a copy: callers pass arrays they still own.
export function overlaysForRole(
  overlays: CategoryOverlay[],
  role: Slide["role"],
): CategoryOverlay[] {
  return overlays
    .filter((o) => o.active && o.roles.includes(role))
    .sort((a, b) => a.sort_order - b.sort_order);
}

// Returns null when nothing was composited, so the caller can skip a second
// Cloudinary upload entirely — which is every category today.
//
// A failing overlay is skipped, never thrown: the generation it belongs to
// has already succeeded, and losing a finished image because a logo URL
// 404'd would be a far worse outcome than a post missing its logo.
export async function compositeOverlays(
  base: Buffer,
  overlays: CategoryOverlay[],
  role: Slide["role"],
): Promise<Buffer | null> {
  const layers = overlaysForRole(overlays, role);
  if (layers.length === 0) return null;

  const meta = await sharp(base).metadata();
  if (!meta.width || !meta.height) return null;

  let current = base;
  let composited = 0;

  for (const o of layers) {
    try {
      const res = await fetch(o.image_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = Buffer.from(await res.arrayBuffer());

      const om = await sharp(raw).metadata();
      if (!om.width || !om.height) throw new Error("overlay image has no dimensions");

      const p = computePlacement(
        { width: meta.width, height: meta.height },
        { width: om.width, height: om.height },
        o,
      );

      let layer = sharp(raw).resize(p.width, p.height, { fit: "fill" }).ensureAlpha();
      if (o.opacity < 100) {
        // Scale the layer's alpha by compositing a uniform grey over it with
        // dest-in, which multiplies destination alpha by source alpha.
        layer = layer.composite([{
          input: {
            create: {
              width: p.width, height: p.height, channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: o.opacity / 100 },
            },
          },
          blend: "dest-in",
        }]);
      }

      const layerBuf = await layer.png().toBuffer();
      current = await sharp(current)
        .composite([{ input: layerBuf, left: p.left, top: p.top }])
        .toBuffer();
      composited++;
    } catch (e) {
      console.error(`overlay "${o.name}" (${o.id}) skipped:`, e);
    }
  }

  // Every layer failed — return null rather than uploading a byte-identical
  // copy of the clean image as though it were a finished one.
  return composited > 0 ? current : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/overlay-composite.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify the opacity recipe against real sharp**

The `dest-in` alpha-scaling recipe above is the one uncertain piece. Verify it once with a throwaway script (do **not** commit it):

```bash
node -e "
const sharp = require('sharp');
(async () => {
  const base = await sharp({create:{width:100,height:100,channels:4,background:{r:255,g:0,b:0,alpha:1}}}).png().toBuffer();
  const layer = await sharp({create:{width:50,height:50,channels:4,background:{r:0,g:0,b:255,alpha:1}}})
    .ensureAlpha()
    .composite([{input:{create:{width:50,height:50,channels:4,background:{r:0,g:0,b:0,alpha:0.5}}},blend:'dest-in'}])
    .png().toBuffer();
  const out = await sharp(base).composite([{input:layer,left:0,top:0}]).raw().toBuffer();
  console.log('pixel at 0,0 (expect a red/blue blend, not pure blue):', out[0], out[1], out[2]);
})();
"
```
Expected: a blended pixel (roughly `128 0 128`), not pure blue (`0 0 255`).

**If the recipe does not work**, do not ship silently-ignored opacity. Instead: drop the `if (o.opacity < 100)` block, treat every overlay as fully opaque, and report this in your report so opacity can be removed from the UI in Task 7 and recorded as a follow-up. The primary assets — QR codes and logos — are opaque anyway.

- [ ] **Step 6: Commit**

```bash
git add lib/athena/overlay-composite.ts tests/overlay-composite.test.ts
git commit -m "feat: role-targeted overlay compositing"
```

---

## Task 5: Composite during ingest

**Files:**
- Create: `lib/overlay-mutations.ts` (the query half only; CRUD arrives in Task 6)
- Modify: `app/api/jobs/poll/route.ts` (`ingestImage`)

**Interfaces:**
- Consumes: `compositeOverlays` (Task 4); `uploadImageToCloudinary` (`lib/cloudinary.ts`).
- Produces: `listOverlaysForCategory(categoryId: string, userId: string): Promise<CategoryOverlay[]>`

- [ ] **Step 1: Write the query helper**

Create `lib/overlay-mutations.ts`:

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { CategoryOverlay } from "@/lib/types";

// These *ForUser-style functions take the tenant's userId as a parameter and
// do NOT authenticate — every caller must have established who the user is
// first. That is why they live here and not in a "use server" file, where
// every export becomes a POST-reachable endpoint. Same pattern and same
// reasoning as lib/category-mutations.ts.

// Filtered by BOTH category and user: the admin client bypasses RLS, so the
// tenant predicate has to be explicit.
export async function listOverlaysForCategory(
  categoryId: string,
  userId: string,
): Promise<CategoryOverlay[]> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("category_overlays").select("*")
    .eq("category_id", categoryId).eq("user_id", userId)
    .order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as CategoryOverlay[];
}
```

- [ ] **Step 2: Composite in ingestImage**

In `app/api/jobs/poll/route.ts`, add imports:

```ts
import { compositeOverlays } from "@/lib/athena/overlay-composite";
import { listOverlaysForCategory } from "@/lib/overlay-mutations";
```

Then, inside `ingestImage`, **after** `const slideCount = ...` (which is after the idea is loaded) and **before** the `if (gen.slide_index === 0)` fan-out block, insert:

```ts
  // Overlays produce a SECOND artifact. public_url above stays the clean
  // image because fanOutCarousel (just below), sweepOrphanedAnchors, and
  // lib/athena/resubmit-slide.ts all hand it to Kie as the carousel anchor —
  // compositing in place would burn a QR code into the model's visual
  // reference for every later slide.
  //
  // Wrapped whole: this generation's status is already committed as
  // succeeded, so a compositing failure must not throw past here and must
  // not block the fan-out below.
  try {
    const { data: catRow } = await supabase
      .from("categories").select("id")
      .eq("key", idea.category_key).eq("user_id", gen.user_id).maybeSingle();
    if (catRow) {
      const overlays = await listOverlaysForCategory((catRow as { id: string }).id, gen.user_id);
      const role = (idea.slides ?? [])[gen.slide_index]?.role ?? "single";
      const composited = await compositeOverlays(jpeg, overlays, role);
      if (composited) {
        const { url: compositedUrl } = await uploadImageToCloudinary(composited, "image/jpeg");
        const { error: compErr } = await supabase
          .from("generations").update({ composited_url: compositedUrl }).eq("id", gen.id);
        if (compErr) throw new Error(compErr.message);
      }
    }
  } catch (e) {
    console.error(`compositing failed for generation ${gen.id}:`, e);
  }
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 4: Confirm the anchor is still clean**

Read `fanOutCarousel`'s call at `app/api/jobs/poll/route.ts` and confirm it is still passed `url` (the clean upload), not `compositedUrl`. Read `sweepOrphanedAnchors` and confirm it still passes `anchor.public_url`. State both in your report — this is the invariant the whole task exists to protect.

- [ ] **Step 5: Commit**

```bash
git add lib/overlay-mutations.ts app/api/jobs/poll/route.ts
git commit -m "feat: composite overlays into a second artifact at ingest"
```

---

## Task 6: Overlay CRUD

**Files:**
- Create: `lib/overlays.ts`
- Modify: `lib/overlay-mutations.ts`, `app/(app)/config/actions.ts`
- Test: `tests/overlays.test.ts`

**Interfaces:**
- Consumes: `CategoryOverlay`, `OverlayCorner` (Task 1); `listOverlaysForCategory` (Task 5).
- Produces:
  - `interface OverlayFields { name, image_url, roles, corner, margin_pct, size_pct, opacity, sort_order, active }`
  - `validateOverlayFields(f: OverlayFields): void` (throws)
  - `createOverlayForUser(userId, categoryId, fields)`, `updateOverlayForUser(userId, id, fields)`, `deleteOverlayForUser(userId, id)`
  - server actions `createOverlay(categoryId, fields)`, `updateOverlay(id, fields)`, `deleteOverlay(id)`

- [ ] **Step 1: Write the failing test**

Create `tests/overlays.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateOverlayFields, type OverlayFields } from "@/lib/overlays";

function fields(over: Partial<OverlayFields> = {}): OverlayFields {
  return {
    name: "QR code", image_url: "https://example.test/qr.png",
    roles: ["payoff"], corner: "bottom-right",
    margin_pct: 5, size_pct: 15, opacity: 100, sort_order: 0, active: true,
    ...over,
  };
}

describe("validateOverlayFields", () => {
  it("accepts a well-formed overlay", () => {
    expect(() => validateOverlayFields(fields())).not.toThrow();
  });

  it("requires a name", () => {
    expect(() => validateOverlayFields(fields({ name: "  " }))).toThrow(/name/i);
  });

  it("requires an image", () => {
    expect(() => validateOverlayFields(fields({ image_url: "" }))).toThrow(/image/i);
  });

  // An overlay targeting nothing would be silently composited nowhere —
  // the user would see no effect and no error.
  it("rejects an empty role selection", () => {
    expect(() => validateOverlayFields(fields({ roles: [] }))).toThrow(/role/i);
  });

  it("rejects an unknown role", () => {
    expect(() => validateOverlayFields(fields({ roles: ["banner" as never] }))).toThrow(/role/i);
  });

  it("rejects a size outside 1-100", () => {
    expect(() => validateOverlayFields(fields({ size_pct: 0 }))).toThrow(/size/i);
    expect(() => validateOverlayFields(fields({ size_pct: 101 }))).toThrow(/size/i);
  });

  it("rejects a margin outside 0-49", () => {
    expect(() => validateOverlayFields(fields({ margin_pct: -1 }))).toThrow(/margin/i);
    expect(() => validateOverlayFields(fields({ margin_pct: 50 }))).toThrow(/margin/i);
  });

  it("rejects an opacity outside 0-100", () => {
    expect(() => validateOverlayFields(fields({ opacity: -1 }))).toThrow(/opacity/i);
    expect(() => validateOverlayFields(fields({ opacity: 101 }))).toThrow(/opacity/i);
  });

  it("rejects an unknown corner", () => {
    expect(() => validateOverlayFields(fields({ corner: "middle-left" as never }))).toThrow(/corner/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/overlays.test.ts`
Expected: FAIL — cannot resolve `@/lib/overlays`.

- [ ] **Step 3: Write the validator**

Create `lib/overlays.ts` (pure — no `server-only`, so the client form can import the type and reuse the rules):

```ts
import type { OverlayCorner, Slide } from "@/lib/types";

export interface OverlayFields {
  name: string;
  image_url: string;
  roles: Slide["role"][];
  corner: OverlayCorner;
  margin_pct: number;
  size_pct: number;
  opacity: number;
  sort_order: number;
  active: boolean;
}

const ROLES = new Set<string>(["hook", "beat", "payoff", "single"]);
const CORNERS = new Set<string>([
  "top-left", "top-right", "bottom-left", "bottom-right", "center",
]);

// Mirrors the CHECK constraints in 0021 plus the rules SQL cannot express.
// Validated here rather than only in the form because the *ForUser functions
// are reachable from the MCP surface in future phases.
export function validateOverlayFields(f: OverlayFields): void {
  if (!f.name.trim()) throw new Error("Give the overlay a name");
  if (!f.image_url.trim()) throw new Error("Upload an image for the overlay");
  // An overlay with no roles composites nowhere — no effect, no error, and
  // nothing on screen to explain why.
  if (!f.roles.length) throw new Error("Pick at least one role for the overlay to appear on");
  for (const r of f.roles) {
    if (!ROLES.has(r)) throw new Error(`Unknown role "${r}"`);
  }
  if (!CORNERS.has(f.corner)) throw new Error(`Unknown corner "${f.corner}"`);
  if (!(f.size_pct > 0 && f.size_pct <= 100)) throw new Error("Size must be between 1 and 100 percent");
  // 50% margin from both sides leaves no room for the overlay at all.
  if (!(f.margin_pct >= 0 && f.margin_pct < 50)) throw new Error("Margin must be between 0 and 49 percent");
  if (!(f.opacity >= 0 && f.opacity <= 100)) throw new Error("Opacity must be between 0 and 100");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/overlays.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add the mutations**

Add this import to the **top** of `lib/overlay-mutations.ts`, alongside the existing ones:

```ts
import { validateOverlayFields, type OverlayFields } from "@/lib/overlays";
```

Then append the three functions:

```ts
export async function createOverlayForUser(
  userId: string, categoryId: string, fields: OverlayFields,
): Promise<void> {
  validateOverlayFields(fields);
  const supabase = createAdminSupabase();
  // The category is re-checked against this user before the insert: category_id
  // arrives from the client, and the admin client would otherwise happily
  // attach an overlay to another tenant's category.
  const { data: cat } = await supabase
    .from("categories").select("id").eq("id", categoryId).eq("user_id", userId).maybeSingle();
  if (!cat) throw new Error("unknown category");

  // Columns enumerated explicitly, never spread from `fields`. These
  // functions are reachable from a "use server" action, where arguments
  // arrive as deserialized JSON and the TypeScript shape is erased — a
  // trailing `...fields` would let a caller-supplied `category_id` override
  // the ownership check above, since a later spread wins in an object
  // literal. Same reasoning and same shape as lib/category-mutations.ts.
  const { error } = await supabase.from("category_overlays").insert({
    user_id: userId,
    category_id: categoryId,
    name: fields.name,
    image_url: fields.image_url,
    roles: fields.roles,
    corner: fields.corner,
    margin_pct: fields.margin_pct,
    size_pct: fields.size_pct,
    opacity: fields.opacity,
    sort_order: fields.sort_order,
    active: fields.active,
  });
  if (error) throw new Error(error.message);
}

export async function updateOverlayForUser(
  userId: string, id: string, fields: OverlayFields,
): Promise<void> {
  validateOverlayFields(fields);
  const supabase = createAdminSupabase();
  // Enumerated, not spread — and note the .eq() calls scope WHICH row is
  // updated, never WHAT is written. Spreading `fields` would carry whatever
  // keys the runtime object happens to have: a Task 7 edit form pre-filled
  // from the existing record would ride `id`, `user_id`, `category_id` and
  // the timestamps straight into the SET clause, with no malice required.
  const { error } = await supabase.from("category_overlays").update({
    name: fields.name,
    image_url: fields.image_url,
    roles: fields.roles,
    corner: fields.corner,
    margin_pct: fields.margin_pct,
    size_pct: fields.size_pct,
    opacity: fields.opacity,
    sort_order: fields.sort_order,
    active: fields.active,
  }).eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function deleteOverlayForUser(userId: string, id: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("category_overlays")
    .delete().eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}
```

Note `category_id` is deliberately absent from `updateOverlayForUser`'s payload — an overlay cannot move between categories through an ordinary save.

- [ ] **Step 6: Add the server actions**

In `app/(app)/config/actions.ts`:

```ts
import {
  createOverlayForUser, updateOverlayForUser, deleteOverlayForUser,
} from "@/lib/overlay-mutations";
import type { OverlayFields } from "@/lib/overlays";
```

```ts
export async function createOverlay(categoryId: string, fields: OverlayFields) {
  const user = await requireUser();
  await createOverlayForUser(user.id, categoryId, fields);
  revalidatePath("/config");
}

export async function updateOverlay(id: string, fields: OverlayFields) {
  const user = await requireUser();
  await updateOverlayForUser(user.id, id, fields);
  revalidatePath("/config");
}

export async function deleteOverlay(id: string) {
  const user = await requireUser();
  await deleteOverlayForUser(user.id, id);
  revalidatePath("/config");
}
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/overlays.ts lib/overlay-mutations.ts "app/(app)/config/actions.ts" tests/overlays.test.ts
git commit -m "feat: overlay validation and CRUD"
```

---

## Task 7: Overlay editor UI

**Files:**
- Create: `app/(app)/config/overlay-section.tsx`
- Modify: `app/(app)/config/category-manager.tsx`, `app/(app)/config/page.tsx`

**Interfaces:**
- Consumes: `OverlayFields` (Task 6), `createOverlay`/`updateOverlay`/`deleteOverlay` (Task 6), `uploadStyleRefImage` (existing), `CategoryOverlay` (Task 1).
- Produces: `<OverlaySection categoryId={string} overlays={CategoryOverlay[]} />`

**Step 0 — mockup gate.** Before writing component code, render the section in the Prime Radiant visual companion and get the human's pick. Show at least: a compact row-per-overlay list with inline fields, versus an expandable card per overlay. Include the empty state and the "save the post type first" state. The approved mockup is the specification for this task's markup.

```bash
/Users/rayyandarugar/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/brainstorming/scripts/start-server.sh --project-dir "$(pwd)" --open
```

- [ ] **Step 1: Load overlays on the config page**

`app/(app)/config/page.tsx` already loads the brand's categories. Add their overlays in one query and pass them down:

```ts
  const categoryIds = ((data ?? []) as Category[]).map((c) => c.id);
  const { data: overlayData } = categoryIds.length
    ? await supabase.from("category_overlays").select("*").in("category_id", categoryIds).order("sort_order")
    : { data: [] as CategoryOverlay[] };
```

Pass `overlays={(overlayData ?? []) as CategoryOverlay[]}` into `<CategoryManager>`. The empty-`.in()` guard matches this repo's convention (`app/(app)/post/page.tsx:49-54`).

- [ ] **Step 2: Build the section**

Create `app/(app)/config/overlay-section.tsx` as a `"use client"` component in the layout chosen at Step 0. It must provide, per overlay: name, image upload (via `uploadStyleRefImage`, showing a thumbnail once set), a role checkbox set for hook/beat/payoff/single, a corner `<select>`, number inputs for margin/size/opacity, a sort-order input, an active `<Switch>`, and Save + Delete. Plus an "Add overlay" control.

Validation on save reuses `validateOverlayFields` from `@/lib/overlays` so the form and the server agree on the rules — catch its throw and show the message, rather than reimplementing the checks in the component.

If the opacity recipe failed verification in Task 4 Step 5, omit the opacity input entirely rather than shipping a control that does nothing.

- [ ] **Step 3: Mount it in the category editor**

In `app/(app)/config/category-manager.tsx`, render `<OverlaySection>` inside `CategoryEditor`, after the role-guides UI. Overlays belong to a saved category, so:

```tsx
{category ? (
  <OverlaySection
    categoryId={category.id}
    overlays={overlays.filter((o) => o.category_id === category.id)}
  />
) : (
  <p className="text-xs text-muted-foreground">
    Save this post type first, then you can add logos and QR codes to it.
  </p>
)}
```

Thread the `overlays` prop from `CategoryManager` down to each `CategoryEditor`.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS. Do not start a long-running dev server; report what could not be verified without a browser.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config/overlay-section.tsx" "app/(app)/config/category-manager.tsx" "app/(app)/config/page.tsx"
git commit -m "feat: overlay editor in the category config"
```

---

## Task 8: Test Run preview compositing

**Files:**
- Modify: `app/api/categories/draft/preview/route.ts`, `lib/style-ref-client.ts`, `app/(app)/config/draft/preview-pane.tsx`

**Interfaces:**
- Consumes: `compositeOverlays` (Task 4), `listOverlaysForCategory` (Task 5).
- Produces: `pollTask(taskId: string, composite?: { categoryId: string; role: Slide["role"] }): Promise<PollResult>`

Test Run should show what a post will actually look like, overlays included. Nothing is persisted — the composited result comes back as a data URI, which `preview-pane.tsx` renders identically to a remote URL, so **no rendering change is needed**.

- [ ] **Step 1: Composite in the preview GET route**

In `app/api/categories/draft/preview/route.ts`'s `GET`, after `getKieRecord` returns:

```ts
    const record = await getKieRecord(kieKey, taskId);

    // Compositing only when the caller names both a category and a role.
    // A poll missing either behaves exactly as before — which is what keeps
    // style-reference generation (no slide role, and a template asset rather
    // than a published post) from ever getting an overlay.
    const categoryId = request.nextUrl.searchParams.get("categoryId");
    const role = request.nextUrl.searchParams.get("role");
    if (record.state === "success" && record.resultUrl && categoryId && role) {
      try {
        const overlays = await listOverlaysForCategory(categoryId, user.id);
        const res = await fetch(record.resultUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const composited = await compositeOverlays(
          Buffer.from(await res.arrayBuffer()), overlays, role as Slide["role"],
        );
        if (composited) {
          return NextResponse.json({
            ...record,
            resultUrl: `data:image/jpeg;base64,${(await sharp(composited).jpeg({ quality: 90 }).toBuffer()).toString("base64")}`,
          });
        }
      } catch (e) {
        // A preview that shows the un-composited image beats a preview that
        // errors — the point of Test Run is seeing the generation at all.
        console.error("preview compositing failed:", e);
      }
    }
    return NextResponse.json(record);
```

Add the imports this needs: `sharp`, `compositeOverlays`, `listOverlaysForCategory`, and the `Slide` type.

`listOverlaysForCategory` filters by `user_id`, so a `categoryId` belonging to another tenant yields an empty list and no compositing — no extra ownership check needed.

- [ ] **Step 2: Forward the parameters from pollTask**

In `lib/style-ref-client.ts`:

```ts
export async function pollTask(
  taskId: string,
  composite?: { categoryId: string; role: string },
): Promise<PollResult> {
```

and build the URL at the existing fetch (currently line 29):

```ts
      const params = new URLSearchParams({ taskId });
      if (composite) {
        params.set("categoryId", composite.categoryId);
        params.set("role", composite.role);
      }
      const res = await fetch(`/api/categories/draft/preview?${params}`);
```

**Leave `generateStyleRef`'s call at line 71 unchanged.** It passes no `composite` argument, which is exactly what keeps a brand reference image from ever being composited.

- [ ] **Step 3: Pass the arguments from the two slide polls**

In `app/(app)/config/draft/preview-pane.tsx`, both slide polls gain the argument. `categoryId` is already in scope in both functions.

In `runTest`, at the anchor poll (currently line 106) — the anchor is always slide 0:

```ts
      const done = await pollTask(json.taskId, { categoryId, role: json.slides[0].role });
```

In `fullTest`, inside `taskIds.map(async (taskId, i) => {` (currently line 144):

```ts
            done = await pollTask(taskId, { categoryId, role: run.slides[i + 1].role });
```

**`i + 1`, not `i`.** The fan-out task list covers slides 1..N because slide 0 is the anchor — `lib/athena/preview.ts:122` maps fan-out index `i` to `slides[i + 1]`. Using `i` here would composite each slide against the previous slide's role, so a payoff-only QR code would land on the wrong panel and the payoff slide would get nothing. Guard the access (`run.slides[i + 1]?.role`) or bail if it is missing, rather than throwing inside the poll callback — that file's comment at the `Promise.all` explains why one slide's failure must not strand its siblings.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 5: Confirm style-ref polling is untouched**

Run:
```bash
grep -n "pollTask(" lib/style-ref-client.ts "app/(app)/config/draft/preview-pane.tsx"
```
Expected: three call sites — two in `preview-pane.tsx` **with** a composite argument, one in `style-ref-client.ts` (inside `generateStyleRef`) **without**. State this in your report.

- [ ] **Step 6: Commit**

```bash
git add app/api/categories/draft/preview/route.ts lib/style-ref-client.ts "app/(app)/config/draft/preview-pane.tsx"
git commit -m "feat: Test Run previews show composited overlays"
```
