# Asset Compositing B2: Per-Idea Overlay Slots — Design Spec

**Date:** 2026-08-11
**Status:** approved for planning
**Builds on:** `2026-08-10-asset-compositing-design.md` (B1) — the two-artifact model, `compositeOverlays`, `computePlacement`, `publishedImageUrl`, `category_overlays`, and migration `0021`.

## 1. Summary

A category defines a placement with no image — *"speaker photo, bottom-left, 35%, on the hook slide"* — and each idea fills it with its own upload. Twelve speakers, one layout, zero per-post fiddling.

This is the case a real coworker hit and could not do: a speaker-promo series where the layout is constant and the face changes. B1 shipped the half where the image is constant (a logo, a QR code); this is the half where it varies.

The governing rule from B1 is unchanged and still load-bearing: **content that must be exact is composited, never generated.** A real named speaker's face is not a generative reference — `gpt-image-2` produces a likeness, and a likeness of a named person on a promo is a liability.

## 2. Data model

**`slot_key` from B1's sketch is not needed and is not added.** `idea_overlay_fills` joins on `overlay_id` directly, so a slot key would only ever be a human label — which `name` already is.

```sql
alter table category_overlays add column is_slot boolean not null default false;

create table idea_overlay_fills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idea_id uuid not null references ideas(id) on delete cascade,
  overlay_id uuid not null references category_overlays(id) on delete cascade,
  image_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (idea_id, overlay_id)
);
```

Owner-scoped RLS and the shared `set_updated_at()` trigger, matching every per-tenant table here. Index on `idea_id` — the read is always "this idea's fills."

**`is_slot` is explicit rather than inferred from an empty `image_url`.** Inferring would let a mis-saved blank silently turn a logo into a slot, which fails quietly: the logo stops appearing and nothing says why. Validation enforces the pairing — `is_slot false` requires `image_url`; `is_slot true` requires it empty.

**Cascade on `overlay_id`**: deleting a slot deletes its fills. Those images stay in Cloudinary, consistent with how every other upload in this app behaves.

## 3. Resolution — one pure function

```ts
resolveOverlaysForIdea(
  overlays: CategoryOverlay[],
  fills: IdeaOverlayFill[],
): { resolved: CategoryOverlay[]; unfilled: CategoryOverlay[] }
```

- A fixed overlay (`is_slot false`) passes through unchanged.
- A slot with a matching fill is returned with `image_url` substituted from the fill.
- A slot with no fill goes to `unfilled` and is **excluded** from `resolved`.

**`compositeOverlays` does not change.** It receives `resolved` and never learns slots exist. That keeps B1's reviewed compositing untouched, and makes the new logic testable with no image I/O — the same separation that made `computePlacement` testable.

`unfilled` is what drives the badge (§5), so the function returns both rather than silently dropping.

## 4. Where resolution happens

**Ingest — `ingestImage`.** Already loads the category and calls `listOverlaysForCategory`. It gains a fills lookup for `gen.idea_id`, runs `resolveOverlaysForIdea`, and passes `resolved` to `compositeOverlays`. Everything else about that block — the try/catch, the null check, the second upload — is unchanged.

**Re-composite (new).** See §5.

**Test Run.** See §6.

## 5. Re-compositing, and the detail that is easy to get wrong

Saving or removing a fill runs a server action that re-composites that idea's already-succeeded generations. B1 made this cheap by design: the clean image is still stored, so a re-composite is one `sharp` pass and one Cloudinary upload — **no Kie call, no AI spend.**

**Only generations whose role the changed slot targets are touched.** A payoff-only speaker slot means one slide, not five. The role set comes from the slot's own `roles` array.

**Removing a fill must clear `composited_url`, not leave it.**

This is the one genuinely dangerous asymmetry in the design. At ingest, `compositeOverlays` returning `null` means *"there was never anything to composite"*, so nothing is written and `publishedImageUrl` falls back to the clean image — correct. On the re-composite path, `null` can instead mean *"the last applicable overlay just went away"*, and leaving the old value in place means **the published image still shows the speaker you just deleted.** So:

- ingest: `null` → write nothing
- re-composite: `null` → write `''`

Same function, opposite handling, and getting it wrong is invisible until someone notices a removed face still going out.

**Failure handling.** The action re-composites each affected generation independently; one failure is reported and does not abort the rest. A partially applied re-composite leaves each generation individually correct — some updated, some stale — and re-saving fixes it. That is preferable to an all-or-nothing action that leaves nothing updated.

**Two states the action must simply tolerate:**

- **An idea with no succeeded generations yet.** Nothing to re-composite; the action saves the fill and stops. Ingest picks it up when the images land, because §4 resolves fills at ingest time. This is the ordinary path when a photo is added before generating.
- **A slot added to a category whose ideas already generated.** Those ideas have no fill, so they are badged and their published images lack that layer until someone fills them — at which point the re-composite brings them into line without a regeneration. No backfill or migration is needed for this; it falls out of the design.

## 6. Test Run shows a placeholder

Test Run has no idea, so a slot has no image. Rather than skipping slots — which would make the layout of the very thing slots exist for unpreviewable — the preview composites a **neutral placeholder rectangle at the slot's exact computed placement**, so position and size can be judged before any real photo exists.

The placeholder is generated by `sharp` from `computePlacement`'s existing output; no new geometry. It is visually obviously a placeholder (flat fill, a thin border) so it is never mistaken for content.

This is preview-only. The placeholder never reaches Cloudinary, an idea, or Buffer.

## 7. Unfilled slots surface, never block

An idea with an unfilled slot is badged on the **Ideas board** (where it gets filled), the **Gallery**, and the **Post composer** (the last look before publishing). Publishing is never blocked — the post goes out without that layer.

The reasoning: a hard block turns one missing photo into a stuck queue, and the series is usually assembled over several sittings. A badge you cannot miss is enough.

## 8. UI — the fill lives on the idea card

Each idea in a slot-bearing category grows a slot strip beneath its concept: a thumbnail (or a dashed empty box), the slot's name and its placement summary (`bottom-left · 35%`), and an Upload/Replace control. Filling happens where the idea is already being reviewed and approved, and the unfilled badge sits directly above the control that clears it.

Uploads reuse `uploadStyleRefImage` — no new upload path.

Ideas in categories with no slots show nothing new.

## 9. Testing

- **`resolveOverlaysForIdea`** — pure, and the core of this project. Fixed overlays pass through; a slot with a fill is substituted; a slot without one lands in `unfilled` and not `resolved`; several slots with partial fills split correctly; a fill whose `overlay_id` matches nothing is ignored; input arrays are not mutated.
- **The role set for re-compositing** — extracted as a pure function (slot → the roles whose generations need re-compositing) and tested, including a slot targeting several roles.
- **Fill validation** — `is_slot true` requires an empty `image_url`; `is_slot false` requires a non-empty one.

No live-`sharp` or live-network tests, consistent with the repo.

## 10. Out of scope

- **B3 treatments** (shape mask, tint, shadow). Still the next phase, and still the mitigation for having cut background removal.
- **Reusing one fill across several ideas.** Each idea uploads its own image, even if it is the same speaker twice.
- **Bulk fill.** The fill-all table was considered and set aside; if twelve-at-a-time proves painful in practice it is an additive follow-up, not a rework.
- **Retro-compositing on overlay config changes.** Unchanged from B1: config affects future generations; only fills trigger a re-composite, and only for their own idea.
- **Blocking publication on an unfilled slot** (§7).
- **Slots in the MCP surface.** No MCP tool creates or fills slots in B2.
