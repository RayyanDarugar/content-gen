# Category Overlay Compositing — Design Spec

**Date:** 2026-07-30
**Status:** approved for planning
**Depends on:** the existing role system (`categories.role_guides`/`role_ref_urls`, `lib/types.ts`'s `Slide["role"]`); the production image-ingest path (`ingestImage` in `app/api/jobs/poll/route.ts`); the Test Run preview flow (`app/api/categories/draft/preview/route.ts`, `lib/style-ref-client.ts`'s `pollTask`); `uploadStyleRefImage` (`app/(app)/config/actions.ts`) for asset upload; `sharp` (already a dependency, already used for image processing in `ingestImage`).

## 1. Summary

Composite a configurable list of overlay images — a logo, a QR code, anything — onto generated slides, targeted by role (`hook`/`beat`/`payoff`/`single`) and positioned by percentage-based placement (corner + margin + size + opacity), so it scales correctly across this app's different aspect ratios.

This generalizes an idea from the brand track (project 1b, "logo compositing") that assumed a single, always-on, fixed-corner logo per brand. That assumption doesn't fit what's actually wanted: multiple overlay types, targeted at specific roles (a QR code only on the payoff/CTA slide, say), with placement that can move rather than being hardcoded. Configured per category — matching where `role_guides`/`role_ref_urls` already live — not per brand.

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
  size_pct numeric not null default 15,   -- overlay width, as a percentage of the base image's width
  opacity numeric not null default 100,   -- 0-100
  sort_order int not null default 0,      -- stacking order when multiple overlays target the same role
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Owner-scoped RLS (`for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)`), matching every per-tenant table in this schema, plus the shared `set_updated_at()` trigger every table with an `updated_at` column already carries.

**Multiple overlays may target the same role** — a logo and a QR code can both live on the payoff slide, composited in `sort_order`. **An overlay with an empty or all-false `roles` selection is invalid** and should be rejected at the form/validation layer, not silently composited nowhere.

## 3. The compositing function

One function, `compositeOverlays(baseImageBuffer: Buffer, overlays: CategoryOverlay[], role: Slide["role"]): Promise<Buffer>`, in a new `lib/athena/overlay-composite.ts`:

1. Filter `overlays` to `active` entries whose `roles` array includes `role`, sorted by `sort_order`.
2. If the filtered list is empty, return `baseImageBuffer` unchanged — a category with no configured overlays (the common case, and every category today) costs nothing extra in the ingest path.
3. For each overlay in order: fetch its own `image_url` as a buffer, resize via `sharp` to `size_pct`% of the base image's actual width (aspect ratio preserved), compute the pixel offset from `corner` + `margin_pct` against the base image's real dimensions (read via `sharp(baseImageBuffer).metadata()`), apply `opacity` (adjusting the resized overlay's alpha channel before compositing — exact `sharp` API call resolved during implementation, since `sharp`'s `.composite()` does not take a per-layer opacity parameter directly), and composite onto the running buffer.
4. Return the final buffer.

This is deliberately not a pure function (it fetches each overlay's image over the network) — but the placement arithmetic (corner + margin_pct + known dimensions → pixel offset) is a pure, extractable piece and is what gets unit-tested (§6).

## 4. Two call sites, one function

**Production — `ingestImage` in `app/api/jobs/poll/route.ts`.** This function already downloads the raw Kie result and re-encodes it via `sharp` before uploading to Cloudinary as `generations.public_url` — the single value that later gets sent to Buffer verbatim when a post is scheduled (confirmed: `app/api/posts/create/route.ts` reads `g.public_url` directly into the `imageUrls` array it sends). `compositeOverlays` slots in right before that existing encode step.

It needs two additions to what `ingestImage` already has in scope:
- **The category row**, loaded by `idea.category_key` + `gen.user_id` — the exact query `fanOutCarousel` already runs elsewhere in this same file, just not previously needed by `ingestImage`.
- **The slide's role**, already available with no new lookup: `idea.slides[gen.slide_index].role`.

**Test Run — `GET /api/categories/draft/preview`.** This route currently takes only `taskId` and passes Kie's `resultUrl` straight through with no processing. It gains two new optional query parameters, `categoryId` and `role`. `lib/style-ref-client.ts`'s `pollTask` (shared by both Test Run's slide polling and the unrelated style-reference-generation polling) gains matching optional parameters, forwarded onto the GET request only when the caller supplies them.

**Only slide-generation polls supply `categoryId`/`role`.** Style-reference-image generation (`generateStyleRef`, `persistStyleRef`) has no slide role and must never have an overlay composited onto it — a brand's reference image is a template asset, not a published post. The route composites only when both `categoryId` and `role` are present on the request; a poll missing either behaves exactly as it does today (raw passthrough).

When compositing does run and succeeds, the result is returned as a base64 data URI in the same `resultUrl` field the client already reads (`{state: "success", resultUrl: "data:image/jpeg;base64,..."}`) — **no client-side change required.** `preview-pane.tsx` already does `<img src={state.url} />`; a data URI renders identically to a remote URL there. Nothing is written to Cloudinary or any other persistent store for a test run, keeping that card's existing "nothing is saved to your ideas or gallery" copy literally true.

## 5. UI

A new section in Config's category editor (`app/(app)/config/category-manager.tsx`), alongside the existing role-guides UI: a list of the category's overlays, each with an image upload (reusing the existing `uploadStyleRefImage` server action — no new upload path), a role checkbox set (hook/beat/payoff/single), a corner dropdown, and margin/size/opacity number inputs. Add and delete controls, matching the form patterns already used extensively in that file.

## 6. Testing

`compositeOverlays`'s placement arithmetic — corner + margin_pct + known base/overlay dimensions → pixel `{left, top}` offset — is extracted as its own pure function and unit-tested directly, covering all five corner values and boundary cases (margin_pct at 0, overlay wider than the margin allows). No live-`sharp`-encoding or live-network tests, consistent with this repo's convention (nothing in this codebase tests actual image processing output, only the logic around it).

## 7. Out of scope

- A visual drag-and-drop placement editor. Numeric/dropdown form inputs only.
- Animated or video overlays.
- Targeting a specific slide index within a role (e.g. "only the 3rd beat slide") — targeting is role-level only, matching how `role_guides`/`role_ref_urls` already work.
- Any change to `role_guides`/`role_ref_urls` themselves — those remain prompt/seed-image inputs to Kie generation; overlay compositing is a separate, later, post-processing step and does not touch that existing system.
