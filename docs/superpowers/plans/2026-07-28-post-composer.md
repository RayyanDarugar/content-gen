# Post Composer Implementation Plan (Post Menu, Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pool-centric `/post` with a post-centric experience — a cross-category queue of postable ideas, and a Buffer-style composer per idea (copy centerpiece, slide-ordered media strip with per-slot swap, live per-platform preview, queue-or-scheduled posting).

**Architecture:** One shared pure resolver (`resolveValidSlides`) becomes the single source of truth for "which generation is each slide's current image", consumed by the queue, the composer, and posting validation so they cannot disagree. Previews are a shared `PhoneFrame` skeleton plus one thin component per platform, selected via a `normalizeService` helper shared with the copy layer's platform presets.

**Tech Stack:** Next.js App Router (nonstandard — see constraints), Supabase, Buffer GraphQL, lucide-react (already a dependency), vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-post-composer-design.md`

## Global Constraints

- **`resolveValidSlides` is the only place slide-validity is decided.** The queue, composer, and `posts/create` all consume it; `findSupersededGenerationIds` is reimplemented over it and its existing tests must keep passing unchanged (they are the refactor's safety net).
- **Buffer's GraphQL shape for a scheduled (custom-time) post is UNVERIFIED.** Task 5's implementer must confirm it against Buffer's public API documentation before writing the mutation. If it cannot be confirmed, ship queue-only: the datetime picker renders disabled with a visible note, `scheduled_at` stays null, and the report says so. **Never guess a mutation shape.**
- **The idea is marked `posted` only when every declared slide was included** in the post; a partial post leaves the idea postable.
- Count validation is the idea's own resolved slide count — never `category.images_per_carousel`.
- `normalizeService` maps both `twitter` and `x` (case-insensitive, trimmed) to `"x"`, matching `platformPresetFor`'s existing normalization in `lib/athena/prompts.ts`.
- **X renders multi-image as a 2×2 mosaic, not a carousel** (X carries no carousels; the preview must surface that).
- Migration 0013 must dedupe existing `buffer_connections` labels BEFORE adding the unique constraint, or it fails on real data.
- **This is NOT the Next.js you know** (AGENTS.md): dynamic-route params and `searchParams` conventions differ — read `app/(app)/config/draft/page.tsx` (an existing dynamic-ish server page) and `node_modules/next/dist/docs/` before writing route files.
- Tests: `npx vitest run` (190 passing at plan time). Battery adds `npx tsc --noEmit`, `npm run build`, `npx eslint .` — pre-existing findings only (`app/(app)/post/post-composer.tsx` set-state-in-effect error, `scripts/import-athena-legacy.ts` unused-var warning). NOTE: the post-composer error's file is REPLACED in Task 4 — after that task, eslint should show only the import-athena-legacy warning; report the change rather than treating the disappearance as a regression.

---

### Task 1: Migration 0013 and types

**Files:**
- Create: `supabase/migrations/0013_post_scheduling.sql`
- Modify: `lib/types.ts` (`Post.scheduled_at`)

**Interfaces:**
- Produces: `Post.scheduled_at: string | null`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0013_post_scheduling.sql
-- Post Menu phase 2 (spec 2026-07-28-post-composer-design.md).
-- A post either rides Buffer's own queue (scheduled_at null, the default)
-- or carries a custom time the user picked in the composer.
alter table posts add column scheduled_at timestamptz;

-- Phase 1 punch-list: connection labels drive the channel picker's
-- optgroups, so duplicates are ambiguous, and any future join on label
-- would fan out. Dedupe first — the constraint would otherwise fail on
-- existing data.
with numbered as (
  select id, row_number() over (partition by user_id, label order by created_at, id) as n
  from buffer_connections
)
update buffer_connections bc
set label = bc.label || ' (' || numbered.n || ')'
from numbered
where numbered.id = bc.id and numbered.n > 1;

alter table buffer_connections
  add constraint buffer_connections_user_label_unique unique (user_id, label);

-- Phase 1 punch-list: every other timestamped table has this trigger
-- (see 0001_init.sql); without it updated_at freezes on future edits.
create trigger buffer_connections_updated_at before update on buffer_connections
  for each row execute function set_updated_at();
```

- [ ] **Step 2: Update the type**

`lib/types.ts` — `Post` gains `scheduled_at: string | null;` after `buffer_channel_id`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — clean. Run: `npx vitest run` — 190 pass.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0013_post_scheduling.sql lib/types.ts
git commit -m "feat: scheduled_at on posts, unique connection labels, updated_at trigger"
```

---

### Task 2: `resolveValidSlides` — the shared slide resolver

**Files:**
- Modify: `lib/athena/carousel.ts`
- Test: `tests/carousel.test.ts` (extend)

**Interfaces:**
- Produces (Tasks 3-5 consume):
  ```ts
  export interface SlideResolution { slideIndex: number; generationId: string | null; publicUrl: string }
  export function resolveValidSlides(
    slideCount: number,
    siblings: SiblingGeneration[],   // existing exported type
    urlById?: Map<string, string>,
  ): SlideResolution[]
  ```
  Returns exactly `slideCount` entries (indexes `0..slideCount-1`), each carrying the valid generation for that slide under the idea's **current anchor** (null when that slide has no valid generation yet). `publicUrl` is `""` unless `urlById` supplies one. `findSupersededGenerationIds` is reimplemented over it with its existing behavior and tests unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/carousel.test.ts` (mirror the fixtures already used by the `findSupersededGenerationIds` tests in that file — read them first and reuse their shape):

```ts
import { resolveValidSlides } from "@/lib/athena/carousel";

const gen = (
  id: string, slide_index: number, anchor: string | null,
  created_at: string, status = "succeeded",
) => ({ id, idea_id: "i1", slide_index, anchor_generation_id: anchor, status, created_at });

describe("resolveValidSlides", () => {
  it("resolves a complete carousel in slide order", () => {
    const out = resolveValidSlides(3, [
      gen("a", 0, null, "2026-01-01"),
      gen("b", 1, "a", "2026-01-02"),
      gen("c", 2, "a", "2026-01-03"),
    ]);
    expect(out.map((s) => s.slideIndex)).toEqual([0, 1, 2]);
    expect(out.map((s) => s.generationId)).toEqual(["a", "b", "c"]);
  });

  it("returns null for a slide with no succeeded generation", () => {
    const out = resolveValidSlides(3, [gen("a", 0, null, "2026-01-01"), gen("b", 1, "a", "2026-01-02")]);
    expect(out[2].generationId).toBeNull();
  });

  it("prefers the newest generation for a retried slide", () => {
    const out = resolveValidSlides(2, [
      gen("a", 0, null, "2026-01-01"),
      gen("b", 1, "a", "2026-01-02"),
      gen("b2", 1, "a", "2026-01-05"),
    ]);
    expect(out[1].generationId).toBe("b2");
  });

  it("ignores siblings of a superseded anchor after a re-anchor", () => {
    const out = resolveValidSlides(2, [
      gen("a1", 0, null, "2026-01-01"),
      gen("b1", 1, "a1", "2026-01-02"),
      gen("a2", 0, null, "2026-01-10"), // re-anchored
    ]);
    expect(out[0].generationId).toBe("a2");
    expect(out[1].generationId).toBeNull(); // b1 belonged to the old anchor
  });

  it("ignores failed generations", () => {
    const out = resolveValidSlides(1, [gen("a", 0, null, "2026-01-01", "failed")]);
    expect(out[0].generationId).toBeNull();
  });

  it("fills publicUrl from the provided map", () => {
    const out = resolveValidSlides(1, [gen("a", 0, null, "2026-01-01")], new Map([["a", "https://x/a.png"]]));
    expect(out[0].publicUrl).toBe("https://x/a.png");
  });

  it("handles a single-slide idea", () => {
    const out = resolveValidSlides(1, [gen("a", 0, null, "2026-01-01")]);
    expect(out).toHaveLength(1);
    expect(out[0].generationId).toBe("a");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/carousel.test.ts`
Expected: FAIL — `resolveValidSlides` is not exported.

- [ ] **Step 3: Implement**

In `lib/athena/carousel.ts`, add `resolveValidSlides` by lifting the per-idea logic already inside `findSupersededGenerationIds` (anchor = newest succeeded slide-0 row; a non-anchor slide's valid row = newest succeeded row whose `anchor_generation_id` equals that anchor's id):

```ts
export interface SlideResolution {
  slideIndex: number;
  generationId: string | null;
  publicUrl: string;
}

// The single source of truth for "which generation is this slide's current
// image". The queue, the composer, and posts/create all read it, so they
// cannot disagree about whether a carousel is postable. findSupersededGenerationIds
// is implemented over it for the same reason.
export function resolveValidSlides(
  slideCount: number,
  siblings: SiblingGeneration[],
  urlById?: Map<string, string>,
): SlideResolution[] {
  const succeeded = siblings.filter((g) => g.status === "succeeded");
  const anchors = succeeded.filter((g) => g.slide_index === 0);
  const anchor = anchors.length
    ? anchors.reduce((newest, g) => (g.created_at > newest.created_at ? g : newest))
    : null;

  const bestForSlide = new Map<number, { id: string; created_at: string }>();
  if (anchor) {
    bestForSlide.set(0, { id: anchor.id, created_at: anchor.created_at });
    for (const g of succeeded) {
      if (g.slide_index === 0 || g.anchor_generation_id !== anchor.id) continue;
      const cur = bestForSlide.get(g.slide_index);
      if (!cur || g.created_at > cur.created_at) {
        bestForSlide.set(g.slide_index, { id: g.id, created_at: g.created_at });
      }
    }
  }

  return Array.from({ length: slideCount }, (_, slideIndex) => {
    const best = bestForSlide.get(slideIndex);
    return {
      slideIndex,
      generationId: best?.id ?? null,
      publicUrl: best ? (urlById?.get(best.id) ?? "") : "",
    };
  });
}
```

Then reimplement `findSupersededGenerationIds` over it — group `siblings` by `idea_id`, call `resolveValidSlides` per idea with a slide count of `max(slide_index) + 1` across that idea's rows, build the same `validIdByKey` map, and keep the final filter identical. Its existing tests must pass unchanged; do not edit them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/carousel.test.ts` — all pass, including the untouched `findSupersededGenerationIds` cases.
Run: `npx vitest run` — 190+ pass.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/carousel.ts tests/carousel.test.ts
git commit -m "feat: resolveValidSlides as the shared slide-validity resolver"
```

---

### Task 3: Service normalization and the preview components

Built before the composer so the composer can mount finished previews.

**Files:**
- Create: `lib/platform.ts`
- Create: `components/preview/phone-frame.tsx`
- Create: `components/preview/platform-preview.tsx` (selector + the four platform components + generic)
- Test: `tests/platform.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lib/platform.ts
  export type PlatformKey = "tiktok" | "instagram" | "linkedin" | "x" | "generic";
  export function normalizeService(service: string): PlatformKey;
  export function platformCharLimit(key: PlatformKey): number | null; // x => 280, else null
  ```
  ```tsx
  // components/preview/platform-preview.tsx
  export function PlatformPreview(props: {
    service: string;
    imageUrls: string[];
    caption: string;
    accountName: string;
    avatarUrl: string;
    aspectRatio: string; // e.g. "4:5", "9:16"
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

`tests/platform.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeService, platformCharLimit } from "@/lib/platform";

describe("normalizeService", () => {
  it("maps the four known platforms", () => {
    expect(normalizeService("tiktok")).toBe("tiktok");
    expect(normalizeService("instagram")).toBe("instagram");
    expect(normalizeService("linkedin")).toBe("linkedin");
  });
  it("maps both twitter and x to x, case-insensitively", () => {
    expect(normalizeService("twitter")).toBe("x");
    expect(normalizeService("X")).toBe("x");
    expect(normalizeService("  Twitter  ")).toBe("x");
  });
  it("falls back to generic for unknown and empty", () => {
    expect(normalizeService("mastodon")).toBe("generic");
    expect(normalizeService("")).toBe("generic");
  });
});

describe("platformCharLimit", () => {
  it("is 280 for x and null elsewhere", () => {
    expect(platformCharLimit("x")).toBe(280);
    expect(platformCharLimit("linkedin")).toBeNull();
    expect(platformCharLimit("generic")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `lib/platform.ts`**

```ts
export type PlatformKey = "tiktok" | "instagram" | "linkedin" | "x" | "generic";

// Same normalization the copy layer's platformPresetFor uses (trim +
// lowercase, twitter and x both meaning X), so a category's preview and its
// generated copy can never disagree about what platform it posts to.
export function normalizeService(service: string): PlatformKey {
  switch (service.trim().toLowerCase()) {
    case "tiktok": return "tiktok";
    case "instagram": return "instagram";
    case "linkedin": return "linkedin";
    case "twitter":
    case "x": return "x";
    default: return "generic";
  }
}

export function platformCharLimit(key: PlatformKey): number | null {
  return key === "x" ? 280 : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/platform.test.ts` — PASS.

- [ ] **Step 5: Build the preview components**

`components/preview/phone-frame.tsx` — the shared skeleton:

```tsx
export function PhoneFrame({
  aspectRatio, children,
}: { aspectRatio: string; children: React.ReactNode }) {
  const [w, h] = aspectRatio.split(":").map((n) => Number(n) || 1);
  return (
    <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-2xl border bg-black text-white shadow-lg">
      <div className="relative w-full" style={{ aspectRatio: `${w} / ${h}` }}>
        {children}
      </div>
    </div>
  );
}
```

`components/preview/platform-preview.tsx` — the selector plus five components. Requirements each must meet (styling is yours; the repo uses Tailwind + shadcn idioms, see `app/(app)/gallery/gallery-card.tsx` for house style):

- **TikTokPreview:** full-bleed current slide inside `PhoneFrame`; top row "Following | For You" with the active tab underlined; right-edge vertical action rail using lucide icons (`Heart`, `MessageCircle`, `Bookmark`, `Share2`); bottom-left `@accountName` and the caption clamped to 2 lines; `1/N` pager chip top-right when `imageUrls.length > 1`.
- **InstagramPreview:** top bar with a round avatar and `accountName`; the current slide (not full-bleed — the frame's aspect ratio governs); action row (`Heart`, `MessageCircle`, `Send`, `Bookmark`); caption line prefixed by a bold `accountName` and truncated with `… more` past ~2 lines; centered dot pager when multi-slide.
- **LinkedInPreview:** light-background card (override the frame's dark bg for this one); avatar, bold name, muted headline line ("Sponsored"-free — use the brand name); the caption ABOVE the image, clamped to ~3 lines with a `…see more` affordance; the current slide below; a bottom reaction bar (`ThumbsUp`, `MessageCircle`, `Repeat2`, `Send`).
- **XPreview:** light-background card; avatar, bold name, muted `@handle` (derive `@` + accountName lowercased, spaces stripped); the caption with the portion beyond 280 characters rendered in a red-tinted span so the overflow is visible; **images as a mosaic, not a carousel** — 1 image full width, 2 side-by-side, 3 as one large + two stacked, 4+ as a 2×2 grid showing the first four with a `+N` badge when more.
- **GenericPreview:** the frame, the first image, the caption below in plain text.

The selector:
```tsx
export function PlatformPreview({ service, imageUrls, caption, accountName, avatarUrl, aspectRatio }: {...}) {
  const key = normalizeService(service);
  const props = { imageUrls, caption, accountName, avatarUrl, aspectRatio };
  if (key === "tiktok") return <TikTokPreview {...props} />;
  if (key === "instagram") return <InstagramPreview {...props} />;
  if (key === "linkedin") return <LinkedInPreview {...props} />;
  if (key === "x") return <XPreview {...props} />;
  return <GenericPreview {...props} />;
}
```

Multi-slide previews (TikTok/Instagram) hold their own `current` index state with small prev/next affordances so the whole carousel is inspectable. Every `<img>` needs an `onError` fallback to a neutral placeholder block — a broken image must never blank the preview. Use `// eslint-disable-next-line @next/next/no-img-element` where the repo already does for remote images.

- [ ] **Step 6: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean.

- [ ] **Step 7: Commit**

```bash
git add lib/platform.ts components/preview tests/platform.test.ts
git commit -m "feat: per-platform post previews (TikTok, Instagram, LinkedIn, X, generic)"
```

---

### Task 4: The queue and the composer

**Files:**
- Create: `lib/athena/queue.ts` (pure row derivation)
- Modify: `app/(app)/post/page.tsx` (becomes the queue)
- Create: `app/(app)/post/[ideaId]/page.tsx` (composer server page)
- Create: `app/(app)/post/[ideaId]/composer.tsx` (composer client)
- Delete: `app/(app)/post/post-composer.tsx`
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: `resolveValidSlides`/`SlideResolution` (Task 2), `PlatformPreview`/`normalizeService`/`platformCharLimit` (Task 3), `resolveInitialCaption`/`pickCaption` (existing, `lib/athena/carousel.ts`), `POST /api/posts/rewrite-caption` (existing: `{categoryKey, ideaId?, note, imageUrls, currentText}` → `{text}`).
- Produces:
  ```ts
  // lib/athena/queue.ts
  export interface QueueRow {
    ideaId: string; categoryKey: string; concept: string; postText: string;
    thumbnailUrl: string; readyCount: number; slideCount: number;
  }
  export function buildQueueRows(
    ideas: { id: string; category_key: string; concept: string; post_text: string; slides: unknown[]; created_at: string; generations: SiblingGeneration[] }[],
    urlById: Map<string, string>,
  ): QueueRow[]
  ```
  Rows for ideas with `readyCount > 0`, newest idea first; `thumbnailUrl` is the first resolved slide's url.

- [ ] **Step 1: Write the failing test**

`tests/queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildQueueRows } from "@/lib/athena/queue";

const g = (id: string, slide_index: number, anchor: string | null, created_at: string) =>
  ({ id, idea_id: "x", slide_index, anchor_generation_id: anchor, status: "succeeded", created_at });

const idea = (id: string, created_at: string, slideCount: number, generations: ReturnType<typeof g>[]) => ({
  id, category_key: "CAT", concept: `concept ${id}`, post_text: "copy",
  slides: Array.from({ length: slideCount }, () => ({})), created_at, generations,
});

const urls = new Map([["a", "https://x/a.png"], ["b", "https://x/b.png"]]);

describe("buildQueueRows", () => {
  it("reports ready and total counts for a partial carousel", () => {
    const rows = buildQueueRows([idea("i1", "2026-01-02", 3, [g("a", 0, null, "2026-01-01"), g("b", 1, "a", "2026-01-02")])], urls);
    expect(rows[0].readyCount).toBe(2);
    expect(rows[0].slideCount).toBe(3);
    expect(rows[0].thumbnailUrl).toBe("https://x/a.png");
  });
  it("omits ideas with no succeeded slides", () => {
    expect(buildQueueRows([idea("i2", "2026-01-02", 2, [])], urls)).toEqual([]);
  });
  it("orders newest idea first", () => {
    const rows = buildQueueRows([
      idea("old", "2026-01-01", 1, [g("a", 0, null, "2026-01-01")]),
      idea("new", "2026-02-01", 1, [g("a", 0, null, "2026-01-01")]),
    ], urls);
    expect(rows.map((r) => r.ideaId)).toEqual(["new", "old"]);
  });
  it("treats an idea with no declared slides as one slide", () => {
    const rows = buildQueueRows([idea("i3", "2026-01-02", 0, [g("a", 0, null, "2026-01-01")])], urls);
    expect(rows[0].slideCount).toBe(1);
    expect(rows[0].readyCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queue.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `lib/athena/queue.ts`**

```ts
import { resolveValidSlides, type SiblingGeneration } from "@/lib/athena/carousel";

export interface QueueRow {
  ideaId: string; categoryKey: string; concept: string; postText: string;
  thumbnailUrl: string; readyCount: number; slideCount: number;
}

export function buildQueueRows(
  ideas: {
    id: string; category_key: string; concept: string; post_text: string;
    slides: unknown[]; created_at: string; generations: SiblingGeneration[];
  }[],
  urlById: Map<string, string>,
): QueueRow[] {
  return ideas
    .map((idea) => {
      const slideCount = (idea.slides ?? []).length || 1;
      const resolved = resolveValidSlides(slideCount, idea.generations, urlById);
      const ready = resolved.filter((s) => s.generationId);
      return {
        ideaId: idea.id, categoryKey: idea.category_key, concept: idea.concept,
        postText: idea.post_text ?? "", thumbnailUrl: ready[0]?.publicUrl ?? "",
        readyCount: ready.length, slideCount, createdAt: idea.created_at,
      };
    })
    .filter((r) => r.readyCount > 0)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ createdAt: _createdAt, ...row }) => row);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/queue.test.ts` — PASS.

- [ ] **Step 5: Rewrite `/post` as the queue**

`app/(app)/post/page.tsx`: keep the existing categories/ideas/posts queries (the ideas query already selects `*, generations(*)` and filters `status in ("generated","generating")` — add `"approved"` so freshly-generated single-slide ideas appear too, and exclude `posted`). Build `urlById` from every succeeded generation, call `buildQueueRows`, and render rows as links to `/post/${row.ideaId}`. Each row shows: thumbnail (`<img>` with the eslint-disable comment the repo uses), a category badge colored by `categoryColor(row.categoryKey)`, the concept, a one-line copy snippet when `postText` is non-empty, and a readiness badge — `${readyCount}/${slideCount} ready` styled `success` when equal, `pending` otherwise. Empty state: "Nothing ready to post yet — generate some ideas first." Keep the existing recent-posts section below unchanged.

- [ ] **Step 6: Build the composer server page**

`app/(app)/post/[ideaId]/page.tsx` — read `app/(app)/config/draft/page.tsx` first for this Next version's async-params convention and mirror it exactly. It must: `requireUser()`; load the idea with its generations; 404 (`notFound()`) when missing; load the idea's category; load the category's connection channel list via `getBufferChannelsForConnection(user.id, category.buffer_connection_id)` inside a try/catch (failure → empty list + an error string); load the category's other postable images (the same per-category pool the old page built, for the swap menu); compute `resolveValidSlides`; and pass everything to the client composer. Include a `channelMissing` boolean: true when the category has no `buffer_connection_id`, or its `buffer_channel_id` is absent from the fetched channel list while that fetch succeeded (the legacy blank-select case from the Phase 1 punch list).

- [ ] **Step 7: Build the composer client**

`app/(app)/post/[ideaId]/composer.tsx` — a client component with three regions (follow `app/(app)/config/draft/draft-wizard.tsx` for the repo's client-component idioms):

- **Header:** back link to `/post`, the channel chip (avatar + `displayName` + service), or — when `channelMissing` — a destructive-styled warning: "This category's Buffer channel isn't available on its connection. Pick it again in Config." with a link to `/config`, and posting disabled.
- **Copy:** a large `Textarea` initialized to `idea.post_text.trim() || pickCaption(category.post_caption)`; a character counter when `platformCharLimit(normalizeService(category.buffer_channel_service))` is non-null (turning destructive past the limit, non-blocking); and the rewrite-with-notes control (note input + button) calling `/api/posts/rewrite-caption` with `{categoryKey: category.key, ideaId: idea.id, note, imageUrls: <current slot urls>, currentText: <caption>}`, replacing the caption on success and showing an inline error on failure.
- **Media strip:** one slot per resolved slide in order. A filled slot shows its thumbnail plus a "Swap" button opening a menu of that slide's OTHER succeeded generations (newest first) followed by the rest of the category pool; picking one replaces that slot's generation id. An unfilled slot renders a dashed "waiting on generation" placeholder and is excluded from posting. `+ add` appends a pool image as a new slot; each slot has a remove (×) and move left/right controls (reuse the existing composer's `move` pattern — read `app/(app)/post/post-composer.tsx` before deleting it).
- **Preview rail:** `<PlatformPreview service={category.buffer_channel_service} imageUrls={<current slot urls>} caption={caption} accountName={channel?.displayName || brandName} avatarUrl={channel?.avatar ?? ""} aspectRatio={category.aspect_ratio} />`.
- **Footer:** a "Next available" / "Pick a time" toggle (the datetime input disabled if Task 5 reports the scheduled mutation unconfirmed — wire it to a `schedulingEnabled` prop the server page passes as a constant), then a Schedule button posting to `/api/posts/create` with `{category_key, generation_ids: <filled slot ids in order>, caption, scheduled_at?}`. On success show the confirmation and route back to `/post`; on failure show the error inline.

Delete `app/(app)/post/post-composer.tsx`.

- [ ] **Step 8: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean. `npx eslint .` — the deleted post-composer's error should be GONE; only the import-athena-legacy warning remains. Report this change explicitly.

- [ ] **Step 9: Commit**

```bash
git add lib/athena/queue.ts tests/queue.test.ts "app/(app)/post"
git rm "app/(app)/post/post-composer.tsx" 2>/dev/null; git add -A "app/(app)/post"
git commit -m "feat: post queue and Buffer-style composer"
```

---

### Task 5: Slide-aware posting, scheduling, and the completeness rule

**Files:**
- Modify: `lib/athena/carousel.ts` (`buildCreatePostMutation` gains an optional time)
- Modify: `lib/athena/buffer.ts` (`postToBuffer` passes it through)
- Modify: `app/api/posts/create/route.ts`
- Test: `tests/carousel.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveValidSlides` (Task 2).
- Produces: `buildCreatePostMutation(channelId, imageUrls, caption, scheduledAt?: string)`; `postToBuffer(token, channelId, imageUrls, caption, scheduledAt?)`; `POST /api/posts/create` accepting an optional `scheduled_at` ISO string.

- [ ] **Step 1: Confirm Buffer's scheduled-post shape**

**Before writing any mutation code**, confirm against Buffer's public GraphQL API documentation how a custom-time post is created (the existing mutation uses `schedulingType: automatic, mode: addToQueue`). Use WebFetch/WebSearch on Buffer's developer docs. Record in your report: the exact confirmed field(s), or that you could NOT confirm them.

- If confirmed → implement scheduling as below.
- If NOT confirmed → implement `scheduledAt` as a no-op that throws `"Scheduled posting is not wired up yet"` if ever passed, leave the route rejecting a non-null `scheduled_at` with a 400, and note in your report that the composer's picker must stay disabled. **Do not invent a mutation shape.**

- [ ] **Step 2: Write the failing tests**

Append to `tests/carousel.test.ts`:

```ts
describe("buildCreatePostMutation", () => {
  it("uses the queue mode when no time is given", () => {
    const { query } = buildCreatePostMutation("chan-1", ["https://x/a.png"], "hello");
    expect(query).toContain("schedulingType: automatic");
    expect(query).toContain("mode: addToQueue");
  });
  it("passes the caption as a variable, never inlined", () => {
    const { query, variables } = buildCreatePostMutation("chan-1", ["https://x/a.png"], 'has "quotes"');
    expect(variables.text).toBe('has "quotes"');
    expect(query).not.toContain('has "quotes"');
  });
  it("includes every image url as an asset", () => {
    const { query } = buildCreatePostMutation("chan-1", ["https://x/a.png", "https://x/b.png"], "c");
    expect(query).toContain("https://x/a.png");
    expect(query).toContain("https://x/b.png");
  });
});
```

If Step 1 confirmed the scheduled shape, add one more case asserting the confirmed field appears when `scheduledAt` is passed and the queue fields do not. If it did not, add a case asserting the function throws when `scheduledAt` is passed.

- [ ] **Step 3: Run tests to verify they fail (or pass trivially)**

Run: `npx vitest run tests/carousel.test.ts`
Expected: the first three pass already (behavior unchanged); the scheduling case fails until Step 4.

- [ ] **Step 4: Implement the mutation change**

Add the optional fourth parameter to `buildCreatePostMutation` and thread it through `postToBuffer` in `lib/athena/buffer.ts` (which currently takes `(token, channelId, imageUrls, caption)`); when absent, the emitted query must be byte-identical to today's.

- [ ] **Step 5: Rework the posting route**

In `app/api/posts/create/route.ts`:
- Accept an optional `scheduled_at`: `typeof body?.scheduled_at === "string" ? body.scheduled_at : null`, rejecting a non-ISO-parseable value with 400.
- **Replace the count check** — delete `if (generationIds.length !== cat.images_per_carousel)`. Instead, after loading the generations and their idea: when all selected generations belong to ONE idea, compute `resolveValidSlides(slideCount, siblings)` for it and require every submitted id to be one of the resolved ids (the existing `findSupersededGenerationIds` check already enforces this — keep it) and require `generationIds.length >= 1`. A multi-idea (freeform) selection keeps only the superseded check, as today.
- Insert `idea_id` on the success row: the single idea's id when the selection is one idea, else null. Also insert `scheduled_at`.
- **Completeness rule:** mark the idea `posted` only when the number of submitted generations equals its resolved slide count. Otherwise leave its status untouched so a late-succeeding slide can still be posted. (Today's code marks every involved idea posted unconditionally — this is the deferred stranding bug.)

- [ ] **Step 6: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean. `npx eslint .` — only the import-athena-legacy warning.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/carousel.ts lib/athena/buffer.ts app/api/posts/create/route.ts tests/carousel.test.ts
git commit -m "feat: slide-aware posting with idea_id, scheduling, and the completeness rule"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §2 → Task 1; §3 → Task 2; §4 → Task 4 (queue); §5 → Task 4 (composer, incl. the legacy channel warning from §6/§8); §6 → Task 3; §7 → Task 5; §8 error handling → Tasks 4-5 (inline messages specified); §9 testing → Tasks 2-5 (previews deliberately untested per spec); §10 out-of-scope has no tasks.
- **Type consistency:** `SlideResolution`/`resolveValidSlides`/`QueueRow`/`buildQueueRows`/`PlatformKey`/`normalizeService`/`platformCharLimit`/`PlatformPreview` names match across tasks; `SiblingGeneration` is the existing exported type reused throughout.
- **Verify-at-execution items (deliberate, not placeholders):** Buffer's scheduled-post GraphQL shape (Task 5 Step 1, with an explicit fallback path); this Next version's dynamic-route params convention (Task 4 Step 6, read the existing page first); the existing `move`/pool patterns in the old composer before deleting it (Task 4 Step 7).
- **Deploy order:** migration 0013 before the code deploy (the composer reads `scheduled_at`; the unique constraint dedupes labels).
- **Not CI-verifiable:** the previews and the composer are visual — after Task 5 the human should open `/post`, walk one carousel through the composer, and post it.
