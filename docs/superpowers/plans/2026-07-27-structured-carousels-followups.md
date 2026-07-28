# Structured Carousels — Outstanding Work

Written 2026-07-27, immediately after the branch merged (`4f0178c`) and deployed.

Phase A shipped: slides, two-phase generation with anchor fan-out, an orphan
sweep, per-slide retry, manual authoring, anchor-scoped display, and post types.
This file carries what was deliberately left, so it survives the session that
built it. The per-task review ledger lived in the worktree and went with it.

Design intent lives in `docs/superpowers/specs/2026-07-27-structured-carousels-design.md`
— especially §5.6 (retry and failure semantics) and §10 (post types).

---

## 1. The open design question

**Does `role_guides` actually beat the anchor image?**

Every chained slide is told to match the anchor's "persistent elements". If a
hook carries a `MYTH:` tag and a strike-through X, those *are* persistent
elements in that image — and this repo's own measured finding, recorded in
`lib/athena/image-prompt.ts`, is that the reference image overrides
art-direction prose. §10 asserts role scoping stops the payoff being crossed
out. That is prose fighting an image reference in the regime where prose has
already been observed to lose.

Nothing shipped depends on the answer: `post_type` defaults to `independent`,
so no existing category is affected.

**The experiment:** a narrative category whose style guide still contains a
per-panel element, with `role_guides.payoff` saying "no tag, no X". Generate and
look at the payoff.

- Comes back clean → §10 holds.
- Comes back tagged → per-panel elements must be **moved out** of the style
  guide rather than overridden. That means a config-time warning when a style
  guide looks like it contains role-specific treatment, not a prompt tweak.

Until this is settled, treat §10's central claim as unverified.

---

## 2. Phase B — make posting a carousel first-class

Currently a carousel is postable only by hand-picking its slides in order.
Everything here is convenience; nothing is blocked by its absence.

- **Carousel fill in `/post`** — choose an idea, get its slides pre-loaded in
  `slide_index` order. The default fill deliberately skips multi-slide ideas
  today (`lib/athena/carousel.ts`), because nothing sorted by slide index and it
  would have pre-filled a scrambled carousel.
- **Slide-aware count validation** — `app/api/posts/create/route.ts` still
  requires `generation_ids.length === category.images_per_carousel`. A narrative
  carousel's length should come from its own slide count.
- **`posts.idea_id` on creation** — the column exists and is never set. Null
  means hand-assembled; non-null should mean "this post is that carousel".
- **Two-stage generating state in the gallery** — largely covered by the
  thumbnail strip showing per-slide status; revisit only if it still reads as
  stalled during a fan-out.

Gallery grouping and per-slide vs whole-carousel retry were originally Phase B
and are **already done** (`f494583`, `d7776d3`).

---

## 3. Deferred review findings

Small, real, and none blocking. From the whole-branch review and the per-task
reviews.

**Correctness-adjacent**

- `submit-generations.ts` catch path records a failed row **without** the
  `kie_task_id`. Same invisible-spend shape that `orphanedTaskFailureRow` fixed
  in the poll route; that helper drops straight in.
- Posting 4 of 5 slides marks the idea `posted`, so a late-succeeding 5th slide
  becomes permanently unpostable and un-retryable. Reachable now that the
  duplicate-idea check is scoped to `(idea_id, slide_index)`.
- `retryAnchorIfWorthwhile` counts **all** slide-0 rows toward
  `MAX_ANCHOR_ATTEMPTS`, so user-initiated regenerations consume the automatic
  retry budget.
- `/post`'s pool is not anchor-scoped, so after a re-anchor the old anchor's
  siblings stay selectable. `posts/create` correctly rejects them as superseded
  — correct enforcement, dead-end UX. Note `buildSlideView` *is* anchor-scoped
  as of `f494583`; the pool query is not.
- A narrow window exists between an anchor succeeding and its siblings being
  inserted where `isSubmitEligible` reports the idea retryable. A Retry click in
  that window submits a second anchor. Not a correctness bug — anchor scoping
  ignores the stale set — but it spends extra generations.

**Polish**

- `single` is in `RoleGuides` and §10.2 but unreachable in the UI: role-guide
  fields render only for narrative and only for hook/beat/payoff. Either expose
  it or drop it from the documented shape.
- "Images per carousel" means two different things by post type and the label
  doesn't say so. Suggest "Images per post", `min={2}` when narrative, and
  moving the field under the post-type selector whose helper text references it.
- `(idea.slides ?? []).length || 1` appears in three places. A `slideCount(idea)`
  helper would also fix `sweepOrphanedAnchors` using the non-defaulted form.
- `selectAutoFill`'s `slide_count <= 1` duplicates `shouldFanOut`'s
  `slideCount > 1` from the opposite side. Fold together when Phase B touches it.
- The manual-idea dialog's create button is disabled only on an empty concept,
  not on unedited empty slide rows; and with zero active categories it opens
  with an empty select and fails server-side with `unknown category `.
- Four `prompts.test.ts` assertions are keyword substrings (`toContain("5")`)
  that would pass on an unrelated digit.
- `filteredOut` conflates AI-rejected with malformed-shape drops, so the UI can
  report "filtered out 3" for ideas the filter never saw.

---

## 4. Pre-existing, not from this work

- `app/(app)/post/post-composer.tsx:34` — `react-hooks/set-state-in-effect`
  lint error, introduced by `45d8132` (the redesign). Fails `eslint .`; the
  build passes.
- **The Buffer two-account split.** Three of five categories point at channels
  belonging to a different Buffer login, because multi-tenancy replaced the
  shared `BUFFER_TOKEN_1/2` routing with one token per user. Design recorded in
  the project memory: promote the token to a `buffer_connections` table with
  `categories.buffer_connection_id`. Contained, because `getValidBufferToken` is
  already the single boundary. The FK naturally belongs on `series` if the
  brand/format/series model lands first.

---

## 5. Next spec: AI-assisted post-type authoring

Deliberately not folded into this branch. Adding `post_type` and `role_guides`
increased what has to be hand-authored, which is the blank-page problem the
assistant exists to solve.

Shape discussed: one drafting flow, two inputs — **describe it** in plain
English, or **show it** by uploading a screenshot of a post whose format you
like, reverse-engineered by a vision model. Both produce the same object, and
the same flow should revise an existing type.

Safe to defer because of the architectural rule this project settled on: **the
assist lane drafts into the manual lane's objects and never gets its own.** The
config editor built here is the surface an assistant fills in and the one used
to correct it — so it is not throwaway work.

Worth a proper brainstorm rather than a bolt-on: what a draft contains, how you
iterate on it, and whether corrections persist as scoped directives.

---

## 6. Operational

- **The cron-job.org poller was paused for live testing.** Production has the
  fan-out code now, so it is safe to re-enable — and until it is, nothing
  ingests.
- Helper scripts on `main`: `scripts/inspect-carousels.ts` (slide state, anchors,
  status mismatches) and `scripts/watch-poll.ts` (polls until nothing is
  generating; stands in for the cron while paused).
- Migrations `0008` and `0009` are both applied to `ahxuentgbvfuigiiubpz`.
