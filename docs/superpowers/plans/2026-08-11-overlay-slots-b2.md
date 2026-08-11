# Overlay Slots (B2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a category define an overlay placement with no image, so each idea supplies its own — twelve speakers, one layout.

**Architecture:** One pure function, `resolveOverlaysForIdea`, substitutes each slot's image from the idea's fills before compositing, so `compositeOverlays` never learns slots exist. Saving a fill re-composites that idea's affected generations — cheap, because B1 keeps the clean image. See `docs/superpowers/specs/2026-08-11-overlay-slots-design.md`.

**Tech Stack:** Next.js 16.2.10 (App Router, server actions), Supabase (Postgres + RLS), `sharp` 0.35.3, Cloudinary, TypeScript, Vitest, Tailwind + shadcn/ui.

## Global Constraints

- **The model only ever sees clean images; humans and Buffer only ever see finished ones.** `generations.public_url` is the clean carousel anchor and must never carry an overlay. `composited_url` is the published artifact. `publishedImageUrl(gen)` is the chokepoint for display and posting. The two paths that must keep reading `public_url` directly are `sweepOrphanedAnchors` in `app/api/jobs/poll/route.ts` and `lib/athena/resubmit-slide.ts`.
- **`compositeOverlays` must not be modified.** It is B1 code, reviewed and shipped. Slots reach it as ordinary overlays with `image_url` set. If you believe it needs changing, stop and report.
- **Compositing must never fail an ingest.** A generation whose image already succeeded must not be lost because an overlay fetch failed.
- **Never spread caller-supplied objects into a database payload.** Enumerate columns explicitly. Types are erased at the `"use server"` boundary, where arguments arrive as deserialized JSON — B1 shipped a tenant-isolation bug this way and had to fix it. `lib/category-mutations.ts` and `lib/overlay-mutations.ts` are the models.
- **`"use server"` files publish every export as a POST-reachable endpoint.** Every action starts with `requireUser()`; no `userId`-taking function is exported from one.
- **Queries using the service-role admin client (`createAdminSupabase`) must filter by tenant explicitly** — it bypasses RLS. The anon-key session client (`createServerSupabase`) gets the predicate from RLS.
- **Empty `.in()` lists are guarded by convention here** (`app/(app)/post/page.tsx`, and the Ideas/Gallery queries) — skip the query and substitute a typed empty array.
- **Next.js 16.2.10.** Per `AGENTS.md`, App Router APIs differ from your training data — read `node_modules/next/dist/docs/` before using one you are unsure about.
- **Migrations are applied manually by the repo owner.** A task that writes one says so and stops.
- Tests are Vitest (`npm run test`), pure-logic only, flat in `tests/<name>.test.ts`. This repo tests the logic *around* image work, never pixel output.
- Commit after every task. Conventional-commit prefixes.

## Out of scope for B2

B3 treatments (`shape`, `border_*`, `tint*`, `shadow`). Reusing one fill across ideas. Bulk fill. Retro-compositing on overlay *config* changes. Blocking publication on an unfilled slot. Slots in the MCP surface.

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/0022_overlay_slots.sql` | **create** — `category_overlays.is_slot`; `idea_overlay_fills` |
| `lib/types.ts` | **modify** — `CategoryOverlay.is_slot`; `IdeaOverlayFill` |
| `lib/overlays.ts` | **modify** — `OverlayFields.is_slot` + the paired image rule |
| `lib/athena/overlay-slots.ts` | **create** — `resolveOverlaysForIdea`, `slideIndexesForRoles` (both pure) |
| `lib/overlay-fill-mutations.ts` | **create** — fill CRUD + `listFillsForIdea` |
| `lib/overlay-recomposite.ts` | **create** — re-composite an idea's affected generations |
| `lib/athena/overlay-placeholder.ts` | **create** — the Test Run placeholder image |
| `app/(app)/ideas/slot-strip.tsx` | **create** — the fill control on an idea card |
| `app/api/jobs/poll/route.ts` | **modify** — resolve fills before compositing |
| `app/(app)/ideas/actions.ts` | **modify** — `setOverlayFill`, `clearOverlayFill` |

---

## Task 1: Migration, types, and the slot validation rule

**Files:**
- Create: `supabase/migrations/0022_overlay_slots.sql`
- Modify: `lib/types.ts`, `lib/overlays.ts`
- Test: `tests/overlays.test.ts`

**Interfaces:**
- Consumes: `CategoryOverlay`, `OverlayFields` (B1).
- Produces: `CategoryOverlay.is_slot: boolean`; `IdeaOverlayFill`; `OverlayFields.is_slot: boolean` with the paired-image rule.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0022_overlay_slots.sql`:

```sql
-- supabase/migrations/0022_overlay_slots.sql
-- Overlay slots, B2 (spec 2026-08-11-overlay-slots-design.md).
--
-- B1 gave a category a fixed overlay image (a logo, a QR code). A slot is the
-- same placement with the image left to each idea: "speaker photo,
-- bottom-left, 35%, on the hook slide", filled twelve different ways across a
-- twelve-speaker series.

-- Explicit rather than inferred from an empty image_url: inferring would let a
-- mis-saved blank silently turn a logo into a slot, which fails quietly — the
-- logo just stops appearing and nothing says why.
alter table category_overlays add column is_slot boolean not null default false;

-- B1's spec proposed a `slot_key` string. It is deliberately NOT added: fills
-- join on overlay_id, so a key would only ever be a human label, and `name`
-- already is one.
create table idea_overlay_fills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idea_id uuid not null references ideas(id) on delete cascade,
  -- Cascade: deleting a slot deletes its fills. The images stay in Cloudinary,
  -- consistent with every other upload in this app.
  overlay_id uuid not null references category_overlays(id) on delete cascade,
  image_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (idea_id, overlay_id)
);

-- The read is always "this idea's fills".
create index idea_overlay_fills_idea_idx on idea_overlay_fills(idea_id);

alter table idea_overlay_fills enable row level security;
create policy "owner all" on idea_overlay_fills for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger idea_overlay_fills_updated_at before update on idea_overlay_fills
  for each row execute function set_updated_at();
```

- [ ] **Step 2: Add the types**

In `lib/types.ts`, add `is_slot` to `CategoryOverlay` immediately after `image_url`:

```ts
  image_url: string;
  // true → the image comes from each idea's fill, and image_url is empty.
  is_slot: boolean;
```

and add a new interface after `CategoryOverlay`:

```ts
// One idea's image for one slot. Joins on overlay_id, which is why the slot
// needs no key of its own.
export interface IdeaOverlayFill {
  id: string;
  user_id: string;
  idea_id: string;
  overlay_id: string;
  image_url: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Write the failing validation test**

In `tests/overlays.test.ts`, add `is_slot: false` to the existing `fields()` helper's defaults, then add this block after the existing `describe`:

```ts
describe("validateOverlayFields — slots", () => {
  it("accepts a slot with no image, because the idea supplies it", () => {
    expect(() => validateOverlayFields(fields({ is_slot: true, image_url: "" }))).not.toThrow();
  });

  // A slot carrying its own image is contradictory: the per-idea fill would
  // silently win at composite time, so the configured image would never appear
  // and nothing would say why.
  it("rejects a slot that also carries an image", () => {
    expect(() => validateOverlayFields(fields({ is_slot: true, image_url: "https://x.test/a.png" })))
      .toThrow(/slot/i);
  });

  it("still requires an image on a non-slot overlay", () => {
    expect(() => validateOverlayFields(fields({ is_slot: false, image_url: "" })))
      .toThrow(/image/i);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/overlays.test.ts`
Expected: FAIL — `is_slot` is not a property of `OverlayFields`, and the slot cases are not implemented.

- [ ] **Step 5: Implement the rule**

In `lib/overlays.ts`, add `is_slot: boolean;` to `OverlayFields` after `image_url`, and replace the unconditional image check:

```ts
  if (!f.name.trim()) throw new Error("Give the overlay a name");
  // A slot's image comes from each idea's fill (spec §2), so it must NOT carry
  // one of its own — the fill would win at composite time and the configured
  // image would never appear.
  if (f.is_slot) {
    if (f.image_url.trim()) throw new Error("A slot's image comes from each idea — leave its image empty");
  } else if (!f.image_url.trim()) {
    throw new Error("Upload an image for the overlay");
  }
```

Everything below (roles, corner, size, margin, opacity) is unchanged.

- [ ] **Step 6: Verify**

Run: `npx vitest run tests/overlays.test.ts && npx tsc --noEmit`
Expected: tests PASS. **`tsc` will fail** at every site constructing an `OverlayFields` without `is_slot` — `app/(app)/config/overlay-section.tsx`'s draft defaults and `toFields()`. Add `is_slot: false` to the draft defaults and `is_slot: o.is_slot` to `toFields()`. Do not make the field optional.

- [ ] **Step 7: Run the full suite and commit**

Run: `npx vitest run && npm run build`

```bash
git add supabase/migrations/0022_overlay_slots.sql lib/types.ts lib/overlays.ts tests/overlays.test.ts "app/(app)/config/overlay-section.tsx"
git commit -m "feat: slots on category_overlays and idea_overlay_fills"
```

- [ ] **Step 8: Apply the migration**

**STOP.** Migrations are applied manually. Tell the repo owner: "0022 is ready — apply it to Supabase." It is purely additive (`is_slot` defaults false, the new table is unreferenced by old code), so there is no deploy-ordering hazard.

---

## Task 2: Resolution — the pure core

**Files:**
- Create: `lib/athena/overlay-slots.ts`
- Test: `tests/overlay-slots.test.ts`

**Interfaces:**
- Consumes: `CategoryOverlay`, `IdeaOverlayFill` (Task 1).
- Produces:
  - `resolveOverlaysForIdea(overlays: CategoryOverlay[], fills: IdeaOverlayFill[]): { resolved: CategoryOverlay[]; unfilled: CategoryOverlay[] }`
  - `slideIndexesForRoles(slides: Slide[], roles: Slide["role"][]): number[]`

- [ ] **Step 1: Write the failing test**

Create `tests/overlay-slots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveOverlaysForIdea, slideIndexesForRoles } from "@/lib/athena/overlay-slots";
import type { CategoryOverlay, IdeaOverlayFill, Slide } from "@/lib/types";

function ov(over: Partial<CategoryOverlay>): CategoryOverlay {
  return {
    id: "o1", user_id: "u1", category_id: "c1", name: "Logo",
    image_url: "https://x.test/logo.png", is_slot: false,
    roles: ["single"], corner: "bottom-right",
    margin_pct: 5, size_pct: 15, opacity: 100, sort_order: 0, active: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function fill(overlayId: string, imageUrl: string): IdeaOverlayFill {
  return {
    id: `f-${overlayId}`, user_id: "u1", idea_id: "i1",
    overlay_id: overlayId, image_url: imageUrl,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("resolveOverlaysForIdea", () => {
  it("passes a fixed overlay through untouched", () => {
    const logo = ov({ id: "logo" });
    const { resolved, unfilled } = resolveOverlaysForIdea([logo], []);
    expect(resolved).toEqual([logo]);
    expect(unfilled).toEqual([]);
  });

  it("substitutes a filled slot's image so it composites like any overlay", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "" });
    const { resolved, unfilled } = resolveOverlaysForIdea([slot], [fill("speaker", "https://x.test/amara.jpg")]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].image_url).toBe("https://x.test/amara.jpg");
    expect(resolved[0].id).toBe("speaker");
    expect(unfilled).toEqual([]);
  });

  // The whole point of returning two lists: an unfilled slot must be reported,
  // not silently dropped, or a speaker promo ships with no speaker and nothing
  // on screen saying so.
  it("reports an unfilled slot and excludes it from compositing", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "" });
    const { resolved, unfilled } = resolveOverlaysForIdea([slot], []);
    expect(resolved).toEqual([]);
    expect(unfilled.map((o) => o.id)).toEqual(["speaker"]);
  });

  it("splits a mix of fixed, filled and unfilled correctly", () => {
    const list = [
      ov({ id: "logo" }),
      ov({ id: "speaker", is_slot: true, image_url: "" }),
      ov({ id: "sponsor", is_slot: true, image_url: "" }),
    ];
    const { resolved, unfilled } = resolveOverlaysForIdea(list, [fill("speaker", "https://x.test/a.jpg")]);
    expect(resolved.map((o) => o.id)).toEqual(["logo", "speaker"]);
    expect(unfilled.map((o) => o.id)).toEqual(["sponsor"]);
  });

  // An inactive slot cannot composite anyway, so badging it as unfilled would
  // be noise the user cannot act on.
  it("does not report an inactive unfilled slot", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "", active: false });
    const { resolved, unfilled } = resolveOverlaysForIdea([slot], []);
    expect(resolved).toEqual([]);
    expect(unfilled).toEqual([]);
  });

  it("ignores a fill whose overlay is not in the list", () => {
    const logo = ov({ id: "logo" });
    const { resolved } = resolveOverlaysForIdea([logo], [fill("deleted-slot", "https://x.test/ghost.jpg")]);
    expect(resolved).toEqual([logo]);
  });

  it("treats a fill with an empty image_url as no fill at all", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "" });
    const { resolved, unfilled } = resolveOverlaysForIdea([slot], [fill("speaker", "")]);
    expect(resolved).toEqual([]);
    expect(unfilled.map((o) => o.id)).toEqual(["speaker"]);
  });

  it("does not mutate the overlays it was given", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "" });
    resolveOverlaysForIdea([slot], [fill("speaker", "https://x.test/a.jpg")]);
    expect(slot.image_url).toBe("");
  });
});

describe("slideIndexesForRoles", () => {
  const slides: Slide[] = [
    { role: "hook", text: "", visual: "" },
    { role: "beat", text: "", visual: "" },
    { role: "beat", text: "", visual: "" },
    { role: "payoff", text: "", visual: "" },
  ];

  it("finds the one slide a payoff-only slot touches", () => {
    expect(slideIndexesForRoles(slides, ["payoff"])).toEqual([3]);
  });

  it("finds every slide when a slot targets several roles", () => {
    expect(slideIndexesForRoles(slides, ["hook", "beat"])).toEqual([0, 1, 2]);
  });

  it("returns nothing when no slide carries the role", () => {
    expect(slideIndexesForRoles(slides, ["single"])).toEqual([]);
  });

  it("handles an idea with no slides", () => {
    expect(slideIndexesForRoles([], ["hook"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/overlay-slots.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/overlay-slots`.

- [ ] **Step 3: Write the implementation**

Create `lib/athena/overlay-slots.ts`:

```ts
import type { CategoryOverlay, IdeaOverlayFill, Slide } from "@/lib/types";

export interface ResolvedOverlays {
  resolved: CategoryOverlay[];
  unfilled: CategoryOverlay[];
}

// Pure, and no server-only import: this is the core of B2 and it is only
// testable because no image I/O sits beside it — the same separation that
// makes computePlacement testable.
//
// Substituting the fill's image here means compositeOverlays receives ordinary
// overlays with image_url set and never learns slots exist, so B1's reviewed
// compositing is untouched.
export function resolveOverlaysForIdea(
  overlays: CategoryOverlay[],
  fills: IdeaOverlayFill[],
): ResolvedOverlays {
  const byOverlayId = new Map(fills.map((f) => [f.overlay_id, f]));
  const resolved: CategoryOverlay[] = [];
  const unfilled: CategoryOverlay[] = [];

  for (const o of overlays) {
    if (!o.is_slot) {
      resolved.push(o);
      continue;
    }
    const image = byOverlayId.get(o.id)?.image_url;
    if (image) {
      resolved.push({ ...o, image_url: image });
    } else if (o.active) {
      // Reported, not silently dropped — this is what the unfilled badge reads.
      // An inactive slot cannot composite anyway, so badging it would be noise.
      unfilled.push(o);
    }
  }

  return { resolved, unfilled };
}

// Which of an idea's slides a change to one overlay actually affects. A
// payoff-only slot means one re-composite, not one per slide.
export function slideIndexesForRoles(slides: Slide[], roles: Slide["role"][]): number[] {
  const wanted = new Set<string>(roles);
  const out: number[] = [];
  slides.forEach((s, i) => {
    if (wanted.has(s.role)) out.push(i);
  });
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/overlay-slots.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/overlay-slots.ts tests/overlay-slots.test.ts
git commit -m "feat: resolve per-idea slot fills into ordinary overlays"
```

---

## Task 3: Fill storage

**Files:**
- Create: `lib/overlay-fill-mutations.ts`

**Interfaces:**
- Consumes: `IdeaOverlayFill` (Task 1).
- Produces:
  - `listFillsForIdea(ideaId: string, userId: string): Promise<IdeaOverlayFill[]>`
  - `setOverlayFillForUser(userId: string, ideaId: string, overlayId: string, imageUrl: string): Promise<void>`
  - `clearOverlayFillForUser(userId: string, ideaId: string, overlayId: string): Promise<void>`

There is deliberately **no batch list helper here.** The Ideas and Gallery pages need fills for many ideas at once, but they read through `createServerSupabase` (the session client, scoped by RLS) like every other query on those pages — adding an admin-client batch function would be a second, unused way to do the same thing.

- [ ] **Step 1: Write the module**

Create `lib/overlay-fill-mutations.ts`:

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { IdeaOverlayFill } from "@/lib/types";

// These *ForUser functions take the tenant's userId as a parameter and do NOT
// authenticate — every caller must have established who the user is first.
// That is why they live here and not in a "use server" file, where every
// export becomes a POST-reachable endpoint. Same pattern as
// lib/category-mutations.ts and lib/overlay-mutations.ts.
//
// The admin client bypasses RLS, so every query filters by user_id explicitly.

export async function listFillsForIdea(
  ideaId: string,
  userId: string,
): Promise<IdeaOverlayFill[]> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("idea_overlay_fills").select("*")
    .eq("idea_id", ideaId).eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data ?? []) as IdeaOverlayFill[];
}

export async function setOverlayFillForUser(
  userId: string,
  ideaId: string,
  overlayId: string,
  imageUrl: string,
): Promise<void> {
  if (!imageUrl.trim()) throw new Error("Upload an image for the slot");
  const supabase = createAdminSupabase();

  // Both ids arrive from the client, and the admin client would otherwise
  // happily attach a fill to another tenant's idea or overlay.
  const { data: idea } = await supabase
    .from("ideas").select("id").eq("id", ideaId).eq("user_id", userId).maybeSingle();
  if (!idea) throw new Error("unknown idea");
  const { data: overlay } = await supabase
    .from("category_overlays").select("id, is_slot")
    .eq("id", overlayId).eq("user_id", userId).maybeSingle();
  if (!overlay) throw new Error("unknown overlay");
  if (!(overlay as { is_slot: boolean }).is_slot) {
    throw new Error("that overlay is not a slot");
  }

  // Columns enumerated, never spread: types are erased at the "use server"
  // boundary these are reached through.
  const { error } = await supabase.from("idea_overlay_fills").upsert(
    { user_id: userId, idea_id: ideaId, overlay_id: overlayId, image_url: imageUrl },
    { onConflict: "idea_id,overlay_id" },
  );
  if (error) throw new Error(error.message);
}

export async function clearOverlayFillForUser(
  userId: string,
  ideaId: string,
  overlayId: string,
): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("idea_overlay_fills").delete()
    .eq("idea_id", ideaId).eq("overlay_id", overlayId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}
```

Note the `upsert` here is correct and is not the B1 landmine: it conflicts on `(idea_id, overlay_id)` — the natural key of exactly the row being written — not on a tenant id that could match a different row.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. No test in this task — these are thin, tenant-filtered queries with no branching logic worth pinning; the behaviour that matters is covered by Task 2's pure tests and by the ownership checks a reviewer reads directly.

- [ ] **Step 3: Commit**

```bash
git add lib/overlay-fill-mutations.ts
git commit -m "feat: per-idea overlay fill storage"
```

---

## Task 4: Resolve fills during ingest

**Files:**
- Modify: `app/api/jobs/poll/route.ts`

**Interfaces:**
- Consumes: `resolveOverlaysForIdea` (Task 2), `listFillsForIdea` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Resolve before compositing**

In `app/api/jobs/poll/route.ts`, add the imports:

```ts
import { resolveOverlaysForIdea } from "@/lib/athena/overlay-slots";
import { listFillsForIdea } from "@/lib/overlay-fill-mutations";
```

Inside `ingestImage`'s existing compositing block, between the `listOverlaysForCategory` call and the `compositeOverlays` call:

```ts
      const overlays = await listOverlaysForCategory((catRow as { id: string }).id, gen.user_id);
      // Slots take their image from this idea's fills. resolveOverlaysForIdea
      // substitutes them, so compositeOverlays receives ordinary overlays and
      // never learns slots exist. An unfilled slot is simply absent from
      // `resolved` — the post publishes without that layer, badged in the UI.
      const fills = await listFillsForIdea(gen.idea_id, gen.user_id);
      const { resolved } = resolveOverlaysForIdea(overlays, fills);
      const role = (idea.slides ?? [])[gen.slide_index]?.role ?? "single";
      const composited = await compositeOverlays(jpeg, resolved, role);
```

Everything else in that block — the surrounding try/catch, the `if (composited)` guard, the second upload, the `composited_url` update — is unchanged.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 3: Confirm the anchor is still clean**

Read the lines around the block and confirm in your report that `fanOutCarousel` is still passed `url` (the clean upload) and that `sweepOrphanedAnchors` still passes `anchor.public_url`. Quote both. This invariant is the reason the two-artifact model exists and it must be re-checked whenever this function changes.

- [ ] **Step 4: Commit**

```bash
git add app/api/jobs/poll/route.ts
git commit -m "feat: ingest resolves per-idea slot fills"
```

---

## Task 5: Re-compositing when a fill changes

**Files:**
- Create: `lib/overlay-recomposite.ts`
- Modify: `app/(app)/ideas/actions.ts`

**Interfaces:**
- Consumes: `resolveOverlaysForIdea`, `slideIndexesForRoles` (Task 2); `listFillsForIdea` (Task 3); `compositeOverlays` (B1); `listOverlaysForCategory` (B1); `uploadImageToCloudinary` (`lib/cloudinary.ts`).
- Produces:
  - `recompositeIdeaForOverlay(userId: string, ideaId: string, overlayId: string): Promise<{ updated: number; failed: number }>`
  - server actions `setOverlayFill(ideaId: string, overlayId: string, imageUrl: string): Promise<void>` and `clearOverlayFill(ideaId: string, overlayId: string): Promise<void>`

**This task contains the one genuinely dangerous asymmetry in B2. Read Step 1's comment before writing code.**

- [ ] **Step 1: Write the re-composite module**

Create `lib/overlay-recomposite.ts`:

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { compositeOverlays } from "@/lib/athena/overlay-composite";
import { resolveOverlaysForIdea, slideIndexesForRoles } from "@/lib/athena/overlay-slots";
import { listOverlaysForCategory } from "@/lib/overlay-mutations";
import { listFillsForIdea } from "@/lib/overlay-fill-mutations";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import type { CategoryOverlay, Category, Generation, Idea } from "@/lib/types";

// Re-composites the generations one overlay change actually affects.
//
// This is cheap by construction: B1 keeps the clean image in public_url, so a
// re-composite is one sharp pass and one Cloudinary upload — no Kie call and
// no AI spend. That is what makes "add the speaker photo after generating" an
// ordinary action rather than a regeneration.
export async function recompositeIdeaForOverlay(
  userId: string,
  ideaId: string,
  overlayId: string,
): Promise<{ updated: number; failed: number }> {
  const supabase = createAdminSupabase();

  const { data: ideaRow } = await supabase
    .from("ideas").select("*").eq("id", ideaId).eq("user_id", userId).maybeSingle();
  if (!ideaRow) throw new Error("unknown idea");
  const idea = ideaRow as Idea;

  const { data: overlayRow } = await supabase
    .from("category_overlays").select("*")
    .eq("id", overlayId).eq("user_id", userId).maybeSingle();
  if (!overlayRow) throw new Error("unknown overlay");
  const changed = overlayRow as CategoryOverlay;

  const { data: catRow } = await supabase
    .from("categories").select("*")
    .eq("key", idea.category_key).eq("user_id", userId).maybeSingle();
  if (!catRow) throw new Error("unknown category");
  const category = catRow as Category;

  // Only the slides this overlay targets. A payoff-only speaker slot means one
  // re-composite, not one per slide.
  const indexes = slideIndexesForRoles(idea.slides ?? [], changed.roles);
  if (indexes.length === 0) return { updated: 0, failed: 0 };

  const { data: genRows } = await supabase
    .from("generations").select("*")
    .eq("idea_id", ideaId).eq("user_id", userId).eq("status", "succeeded")
    .in("slide_index", indexes);
  const generations = (genRows ?? []) as Generation[];
  if (generations.length === 0) return { updated: 0, failed: 0 };

  const overlays = await listOverlaysForCategory(category.id, userId);
  const fills = await listFillsForIdea(ideaId, userId);
  const { resolved } = resolveOverlaysForIdea(overlays, fills);

  let updated = 0;
  let failed = 0;

  for (const gen of generations) {
    try {
      // Always re-composite from the CLEAN image. Compositing a composited
      // image would stack the old overlay under the new one.
      const res = await fetch(gen.public_url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`clean image fetch failed (HTTP ${res.status})`);
      const base = Buffer.from(await res.arrayBuffer());

      const role = (idea.slides ?? [])[gen.slide_index]?.role ?? "single";
      const composited = await compositeOverlays(base, resolved, role);

      // THE ASYMMETRY (spec §5). At ingest, a null means "there was never
      // anything to composite" and nothing is written. Here it can instead
      // mean "the last applicable overlay just went away" — and leaving the
      // old value in place would keep publishing the speaker that was just
      // deleted. So null clears the column rather than skipping the write.
      let compositedUrl = "";
      if (composited) {
        compositedUrl = (await uploadImageToCloudinary(composited, "image/jpeg")).url;
      }

      const { error } = await supabase
        .from("generations").update({ composited_url: compositedUrl })
        .eq("id", gen.id).eq("user_id", userId);
      if (error) throw new Error(error.message);
      updated++;
    } catch (e) {
      // Each generation is independent: one failure leaves that slide stale
      // but correct, and re-saving fixes it. Aborting the loop would leave
      // nothing updated, which is strictly worse.
      console.error(`re-composite failed for generation ${gen.id}:`, e);
      failed++;
    }
  }

  return { updated, failed };
}
```

- [ ] **Step 2: Add the server actions**

In `app/(app)/ideas/actions.ts`, add the imports:

```ts
import {
  setOverlayFillForUser, clearOverlayFillForUser,
} from "@/lib/overlay-fill-mutations";
import { recompositeIdeaForOverlay } from "@/lib/overlay-recomposite";
```

and the two actions:

```ts
export async function setOverlayFill(
  ideaId: string,
  overlayId: string,
  imageUrl: string,
): Promise<void> {
  const user = await requireUser();
  await setOverlayFillForUser(user.id, ideaId, overlayId, imageUrl);
  // Brings already-generated slides into line without a regeneration. An idea
  // with no succeeded generations yet simply re-composites nothing — ingest
  // will resolve the fill when its images land.
  await recompositeIdeaForOverlay(user.id, ideaId, overlayId);
  revalidatePath("/ideas");
  revalidatePath("/gallery");
}

export async function clearOverlayFill(ideaId: string, overlayId: string): Promise<void> {
  const user = await requireUser();
  await clearOverlayFillForUser(user.id, ideaId, overlayId);
  // Re-composite AFTER the delete, so the removed layer actually disappears
  // from the published image — see the asymmetry note in lib/overlay-recomposite.ts.
  await recompositeIdeaForOverlay(user.id, ideaId, overlayId);
  revalidatePath("/ideas");
  revalidatePath("/gallery");
}
```

- [ ] **Step 3: Raise the action route's budget**

Re-compositing several slides does real network and image work. Add to the top of `app/(app)/ideas/actions.ts`, alongside the existing imports:

```ts
export const maxDuration = 120;
```

This matches every other image-touching route in the repo (`app/api/ideas/generate/route.ts`, `app/api/mcp/route.ts`, and others all set 120).

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/overlay-recomposite.ts "app/(app)/ideas/actions.ts"
git commit -m "feat: re-composite affected slides when a slot fill changes"
```

---

## Task 6: The fill control on the idea card

**Files:**
- Create: `app/(app)/ideas/slot-strip.tsx`
- Modify: `app/(app)/ideas/page.tsx`, `app/(app)/ideas/idea-card.tsx`

**Interfaces:**
- Consumes: `setOverlayFill`, `clearOverlayFill` (Task 5); `uploadStyleRefImage` (`app/(app)/config/actions.ts`); `CategoryOverlay`, `IdeaOverlayFill` (Task 1).
- Produces: `<SlotStrip ideaId={string} slots={CategoryOverlay[]} fills={IdeaOverlayFill[]} />`

The layout was chosen from mockups: **a slot strip beneath the idea's concept** — thumbnail (or a dashed empty box), the slot's name with its placement summary, and an Upload/Replace control. Do not redesign it.

- [ ] **Step 1: Load slots and fills on the Ideas page**

In `app/(app)/ideas/page.tsx`, after `ideas` is computed, add:

```ts
  // Slots for these categories, and the fills the visible ideas already have.
  // Both guarded like every other .in() here — an empty list skips the query.
  const { data: slotData } = categories.length
    ? await supabase
        .from("category_overlays").select("*")
        .in("category_id", categories.map((c) => c.id))
        .eq("is_slot", true).eq("active", true)
        .order("sort_order")
    : { data: [] as CategoryOverlay[] };
  const slots = (slotData ?? []) as CategoryOverlay[];

  const { data: fillData } = ideas.length
    ? await supabase
        .from("idea_overlay_fills").select("*")
        .in("idea_id", ideas.map((i) => i.id))
    : { data: [] as IdeaOverlayFill[] };
  const fills = (fillData ?? []) as IdeaOverlayFill[];

  // An idea knows its category by KEY; a slot knows it by ID.
  const categoryIdByKey = new Map(categories.map((c) => [c.key, c.id]));
```

Add `CategoryOverlay` and `IdeaOverlayFill` to the `@/lib/types` import.

Where `<IdeaCard idea={idea} />` is rendered, pass the idea's own slice:

```tsx
<IdeaCard
  key={idea.id}
  idea={idea}
  slots={slots.filter((s) => s.category_id === categoryIdByKey.get(idea.category_key))}
  fills={fills.filter((f) => f.idea_id === idea.id)}
/>
```

- [ ] **Step 2: Build the strip**

Create `app/(app)/ideas/slot-strip.tsx`:

```tsx
"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { uploadStyleRefImage } from "@/app/(app)/config/actions";
import { setOverlayFill, clearOverlayFill } from "./actions";
import type { CategoryOverlay, IdeaOverlayFill } from "@/lib/types";

export function SlotStrip({
  ideaId, slots, fills,
}: {
  ideaId: string;
  slots: CategoryOverlay[];
  fills: IdeaOverlayFill[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busySlot, setBusySlot] = useState("");
  const [msg, setMsg] = useState("");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  if (slots.length === 0) return null;

  const fillBySlot = new Map(fills.map((f) => [f.overlay_id, f]));

  async function onFile(slotId: string, file: File) {
    setBusySlot(slotId);
    setMsg("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const up = await uploadStyleRefImage(fd);
      if (up.error || !up.url) throw new Error(up.error ?? "upload failed");
      // Saving also re-composites any slides this slot appears on.
      await setOverlayFill(ideaId, slotId, up.url);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusySlot("");
    }
  }

  return (
    <div className="mt-2 space-y-2 border-t border-dashed pt-2">
      {slots.map((slot) => {
        const fill = fillBySlot.get(slot.id);
        const busy = busySlot === slot.id || pending;
        return (
          <div key={slot.id} className="flex items-center gap-2">
            {fill ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fill.image_url} alt="" className="size-8 shrink-0 rounded-md object-cover" />
            ) : (
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
                +
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{slot.name}</p>
              <p className="text-[10px] text-muted-foreground">
                {slot.corner} · {slot.size_pct}%
              </p>
            </div>
            <input
              ref={(el) => { inputs.current[slot.id] = el; }}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset so re-picking the same file fires change again.
                e.target.value = "";
                if (file) void onFile(slot.id, file);
              }}
            />
            <Button
              size="xs" variant="outline" disabled={busy}
              onClick={() => inputs.current[slot.id]?.click()}
            >
              {busy ? "Working…" : fill ? "Replace" : "Upload"}
            </Button>
            {fill && (
              <Button
                size="xs" variant="ghost" disabled={busy}
                onClick={() =>
                  startTransition(async () => {
                    await clearOverlayFill(ideaId, slot.id);
                    router.refresh();
                  })
                }
              >
                Remove
              </Button>
            )}
          </div>
        );
      })}
      {msg && <p className="text-xs text-destructive">{msg}</p>}
    </div>
  );
}
```

Check that `size="xs"` exists on this repo's `Button` before using it — `app/(app)/config/brand-section.tsx` uses it, so it should; if not, use `size="sm"`.

- [ ] **Step 3: Mount it and badge unfilled slots**

In `app/(app)/ideas/idea-card.tsx`, widen the props and render the strip after the concept, plus a badge in the header:

```tsx
export function IdeaCard({
  idea, slots = [], fills = [],
}: {
  idea: Idea;
  slots?: CategoryOverlay[];
  fills?: IdeaOverlayFill[];
}) {
```

```tsx
  const filledIds = new Set(fills.filter((f) => f.image_url).map((f) => f.overlay_id));
  const unfilled = slots.filter((s) => !filledIds.has(s.id));
```

In the header, beside the status badge:

```tsx
{unfilled.length > 0 && (
  <Badge variant="outline" className="border-amber-500/50 text-amber-700">
    {unfilled.length === 1 ? "1 slot unfilled" : `${unfilled.length} slots unfilled`}
  </Badge>
)}
```

and after the concept paragraph:

```tsx
<SlotStrip ideaId={idea.id} slots={slots} fills={fills} />
```

Import `SlotStrip`, `CategoryOverlay` and `IdeaOverlayFill`. Keep the props optional with `[]` defaults so any other caller of `IdeaCard` keeps compiling.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS. Do not start a long-running dev server; report what you could not verify without a browser.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/ideas/slot-strip.tsx" "app/(app)/ideas/page.tsx" "app/(app)/ideas/idea-card.tsx"
git commit -m "feat: fill overlay slots from the ideas board"
```

---

## Task 7: Badge unfilled slots in the Gallery and composer

**Files:**
- Modify: `app/(app)/gallery/page.tsx`, `app/(app)/gallery/gallery-card.tsx`, `app/(app)/post/[ideaId]/page.tsx`, `app/(app)/post/[ideaId]/composer.tsx`

**Interfaces:**
- Consumes: `CategoryOverlay`, `IdeaOverlayFill` (Task 1).
- Produces: nothing new.

The Gallery shows what was made; the composer is the last look before publishing. Both should say when a slide is missing its slot image. **Neither blocks** — publishing an unfilled post is allowed.

- [ ] **Step 1: Compute unfilled counts on the Gallery page**

In `app/(app)/gallery/page.tsx`, the page already loads the brand's category keys. Load ids too, then slots and fills, mirroring the Ideas page's guarded pattern:

```ts
  const { data: catData } = await supabase
    .from("categories").select("id, key").eq("brand_id", brand.id);
  const cats = (catData ?? []) as { id: string; key: string }[];
  const keys = cats.map((c) => c.key);
```

(the existing `keys` derivation is replaced by this — it currently selects only `key`)

then after `ideas` is computed:

```ts
  const { data: slotData } = cats.length
    ? await supabase
        .from("category_overlays").select("*")
        .in("category_id", cats.map((c) => c.id))
        .eq("is_slot", true).eq("active", true)
    : { data: [] as CategoryOverlay[] };
  const slots = (slotData ?? []) as CategoryOverlay[];

  const { data: fillData } = ideas.length
    ? await supabase
        .from("idea_overlay_fills").select("overlay_id, idea_id")
        .in("idea_id", ideas.map((i) => i.id))
    : { data: [] as { overlay_id: string; idea_id: string }[] };
  const fills = (fillData ?? []) as { overlay_id: string; idea_id: string }[];

  const categoryIdByKey = new Map(cats.map((c) => [c.key, c.id]));
  const unfilledByIdea = new Map<string, number>();
  for (const idea of ideas) {
    const ideaSlots = slots.filter((s) => s.category_id === categoryIdByKey.get(idea.category_key));
    const filled = new Set(fills.filter((f) => f.idea_id === idea.id).map((f) => f.overlay_id));
    unfilledByIdea.set(idea.id, ideaSlots.filter((s) => !filled.has(s.id)).length);
  }
```

Pass `unfilledSlots={unfilledByIdea.get(idea.id) ?? 0}` into `<GalleryCard>`.

- [ ] **Step 2: Badge it on the gallery card**

In `app/(app)/gallery/gallery-card.tsx`, widen the props to `{ idea, unfilledSlots = 0 }: { idea: IdeaWithGenerations; unfilledSlots?: number }` and render beside the existing status badge on the image:

```tsx
{unfilledSlots > 0 && (
  <Badge
    variant="outline"
    className="absolute top-2 left-2 border-amber-500/50 bg-background/70 text-amber-700 backdrop-blur-sm"
  >
    {unfilledSlots === 1 ? "1 slot unfilled" : `${unfilledSlots} slots unfilled`}
  </Badge>
)}
```

- [ ] **Step 3: Badge it in the composer**

In `app/(app)/post/[ideaId]/page.tsx`, the category is already loaded as `category`. Add:

```ts
  const { data: slotData } = await supabase
    .from("category_overlays").select("*")
    .eq("category_id", category.id).eq("is_slot", true).eq("active", true);
  const slots = (slotData ?? []) as CategoryOverlay[];
  const { data: fillData } = await supabase
    .from("idea_overlay_fills").select("overlay_id").eq("idea_id", idea.id);
  const filledIds = new Set(((fillData ?? []) as { overlay_id: string }[]).map((f) => f.overlay_id));
  const unfilledSlots = slots.filter((s) => !filledIds.has(s.id)).length;
```

Pass `unfilledSlots={unfilledSlots}` to `<Composer>`, widen its props to accept `unfilledSlots?: number` defaulting to `0`, and render a non-blocking line above the publish controls:

```tsx
{unfilledSlots > 0 && (
  <p className="text-xs text-amber-700">
    {unfilledSlots === 1 ? "1 slot on this post has no image" : `${unfilledSlots} slots on this post have no image`}
    {" — it will publish without it. Add one on the Ideas board."}
  </p>
)}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS. Report what you could not verify without a browser.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/gallery/page.tsx" "app/(app)/gallery/gallery-card.tsx" "app/(app)/post/[ideaId]/page.tsx" "app/(app)/post/[ideaId]/composer.tsx"
git commit -m "feat: badge unfilled slots in the gallery and composer"
```

---

## Task 8: Test Run shows a slot placeholder

**Files:**
- Create: `lib/athena/overlay-placeholder.ts`
- Modify: `app/api/categories/draft/preview/route.ts`
- Test: `tests/overlay-placeholder.test.ts`

**Interfaces:**
- Consumes: `CategoryOverlay` (Task 1).
- Produces: `placeholderFillOverlays(overlays: CategoryOverlay[]): Promise<CategoryOverlay[]>`

Test Run has no idea, so a slot has no image. Rather than skipping slots — which would leave the layout of the very thing slots exist for unpreviewable — the preview substitutes a neutral placeholder so position and size can be judged.

**The trick that keeps `compositeOverlays` untouched:** the placeholder is substituted as the slot's `image_url` in the form of a `data:` URI. `compositeOverlays` fetches `image_url`, and Node's `fetch` resolves `data:` URIs, so no change to B1's function is needed.

- [ ] **Step 1: Write the failing test**

Create `tests/overlay-placeholder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { placeholderFillOverlays } from "@/lib/athena/overlay-placeholder";
import type { CategoryOverlay } from "@/lib/types";

function ov(over: Partial<CategoryOverlay>): CategoryOverlay {
  return {
    id: "o1", user_id: "u1", category_id: "c1", name: "Logo",
    image_url: "https://x.test/logo.png", is_slot: false,
    roles: ["single"], corner: "bottom-right",
    margin_pct: 5, size_pct: 15, opacity: 100, sort_order: 0, active: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("placeholderFillOverlays", () => {
  it("leaves a fixed overlay's image alone", async () => {
    const out = await placeholderFillOverlays([ov({ id: "logo" })]);
    expect(out[0].image_url).toBe("https://x.test/logo.png");
  });

  it("gives a slot a data-URI placeholder so it composites like any overlay", async () => {
    const out = await placeholderFillOverlays([ov({ id: "slot", is_slot: true, image_url: "" })]);
    expect(out).toHaveLength(1);
    expect(out[0].image_url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("does not mutate the overlays it was given", async () => {
    const slot = ov({ id: "slot", is_slot: true, image_url: "" });
    await placeholderFillOverlays([slot]);
    expect(slot.image_url).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/overlay-placeholder.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/overlay-placeholder`.

- [ ] **Step 3: Write the implementation**

Create `lib/athena/overlay-placeholder.ts`:

```ts
import "server-only";
import sharp from "sharp";
import type { CategoryOverlay } from "@/lib/types";

// A square, obviously-artificial block. Square because a slot has no real
// image to take an aspect ratio from, and computePlacement derives height from
// the overlay's own dimensions — so a square placeholder previews the slot's
// width faithfully and makes no claim about the height a real photo will have.
const PLACEHOLDER_PX = 400;

let cached: string | null = null;

async function placeholderDataUri(): Promise<string> {
  if (cached) return cached;
  const fill = await sharp({
    create: {
      width: PLACEHOLDER_PX, height: PLACEHOLDER_PX, channels: 4,
      background: { r: 128, g: 128, b: 128, alpha: 0.55 },
    },
  }).png().toBuffer();
  cached = `data:image/png;base64,${fill.toString("base64")}`;
  return cached;
}

// Test Run only. A slot has no idea to take an image from, so it gets a
// neutral block at its real computed placement — enough to judge position and
// size before any photo exists.
//
// Substituting a data: URI as image_url means compositeOverlays needs no
// change: it fetches image_url, and Node's fetch resolves data: URIs.
//
// Nothing here is ever persisted — no Cloudinary upload, no idea, no Buffer.
export async function placeholderFillOverlays(
  overlays: CategoryOverlay[],
): Promise<CategoryOverlay[]> {
  if (!overlays.some((o) => o.is_slot)) return overlays;
  const uri = await placeholderDataUri();
  return overlays.map((o) => (o.is_slot ? { ...o, image_url: uri } : o));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/overlay-placeholder.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Use it in the preview route**

In `app/api/categories/draft/preview/route.ts`'s `GET`, inside the existing compositing block, substitute placeholders before compositing:

```ts
import { placeholderFillOverlays } from "@/lib/athena/overlay-placeholder";
```

```ts
        const overlays = await listOverlaysForCategory(categoryId, user.id);
        // Test Run has no idea, so slots have no fill. A neutral placeholder
        // at the slot's real placement lets the layout be judged before any
        // photo exists. Never persisted.
        const previewOverlays = await placeholderFillOverlays(overlays);
        const res = await fetch(record.resultUrl);
        // ...unchanged
        const composited = await compositeOverlays(
          Buffer.from(await res.arrayBuffer()), previewOverlays, role as Slide["role"],
        );
```

Everything else in that block — the `compositedUrl` field, the clean `resultUrl`, the try/catch that falls through to the raw record — is unchanged. **Do not put the composited image back into `resultUrl`**; that field is what the fan-out sends to Kie as its anchor.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 7: Confirm the preview wire split survived**

Run:
```bash
grep -n "resultUrl\|compositedUrl\|displayUrl" app/api/categories/draft/preview/route.ts lib/style-ref-client.ts | head -20
```
Confirm in your report that the route still returns the composited image as `compositedUrl` and leaves `resultUrl` clean, and that `pollTask` still exposes both `url` and `displayUrl`. B1 shipped a Critical bug here; it must not regress.

- [ ] **Step 8: Commit**

```bash
git add lib/athena/overlay-placeholder.ts tests/overlay-placeholder.test.ts app/api/categories/draft/preview/route.ts
git commit -m "feat: Test Run previews slots as placeholders"
```
