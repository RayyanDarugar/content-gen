# Suggested Post Types — Design Spec

**Date:** 2026-07-29
**Amended:** 2026-07-30 — an accumulating format library folded in. See §14 for what changed and why.
**Status:** approved for planning
**Depends on:** the AI post-type wizard (merge `b6fbc9e`), brand extraction (merge `ec0a7a4`), and brand design tokens (merge `16b314d`) — this reuses all three and adds no new drafting surface.

## 1. Summary

A user reaching the post-type step can either build their own or ask for one. The system proposes a post type grounded in their brand — config plus a fully-worked sample post plus a rationale — and they iterate on it exactly as they would iterate on their own. Available in the onboarding wizard and in `/config/draft` generally.

Behind it sits a **format library that fills itself**. A format is a post structure worth reusing: how the slides are shaped, why that shape works, where it came from, and what kind of brand can carry it. The library starts empty, accumulates from ordinary use, and is the seam a future scraper of real high-performing posts writes into.

**Why now, not earlier:** suggestion quality is entirely a function of how well the system knows the brand. Before brand extraction it knew tone and audience, which would have produced the generic suggestions that kill trust on first contact. It now knows `proof_points`, `standing`, and the brand's real palette and type.

**Decisions locked with Rayyan (2026-07-29):** a sample post with real copy shown immediately, real images on demand via the wizard's existing test-run; one suggestion at a time with re-roll; two entry points, one implementation.

**Decisions locked with Rayyan (2026-07-30):**

- **The empty library is the fully-supported default, not a degraded mode.** With zero formats, suggestions behave exactly as originally specced — brand knowledge plus craft-plus-fit — with no nag to go seed anything. Claude inventing a post type from its own knowledge and the brand profile is a first-class outcome, not a fallback of last resort.
- **Library-first when something genuinely fits, invent otherwise.** Re-roll never dead-ends on an exhausted library.
- **The invent path writes back**, so the library fills from usage rather than from anyone's discipline.
- **Hand-seeding is a small contribution, not a prerequisite.** Rayyan expects to add a handful of genuinely observed formats; the system must be fully useful before he does and fully useful if he never does.
- **The scraper is deferred to project 2**, and this design is shaped so it lands as a third writer into an existing table rather than a rewrite.

## 2. The core move: a suggestion is an opening turn, not a new surface

`/config/draft?suggest=1` loads the existing wizard, calls the suggestion endpoint on mount, and seeds the conversation with the proposal as its **first assistant turn**. From there every existing mechanism takes over unchanged: the live draft panel, rewrite-with-notes, "Test this draft", continuous upsert, the same `categories` object.

This is what makes iterating on a suggestion identical to iterating on your own — the stated goal — and it means there is no second drafting flow to build or maintain.

It also satisfies the standing architectural rule that **the suggestion lane drafts into the manual lane's objects and never gets its own tables.**

The two tables this spec adds are worth testing against that rule explicitly, since both could look like violations:

- **`formats`** is *input* to a suggestion, not a home for one. A suggested post type still lives in `categories` exactly like a hand-built one, and `formats` is equally available to the manual lane. It is also not new scope invented here — it is project 2's Format object arriving early (§3.1).
- **`format_suggestions`** holds no post type at all. It is an append-only log of what was proposed (§7); deleting the whole table would lose analytics and nothing a user made.

The rule the original spec was protecting against — a second, parallel place where post types live, diverging from the manual lane — still holds.

## 3. The format library

### 3.1 `formats`, landing early but correctly

This is deliberately the same Format object the product direction specced for project 2, arriving ahead of the full Brand/Format/Series split.

| column | type | purpose |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid not null → `auth.users` | the tenant who authored it |
| `name` | text not null | e.g. "Startups that need to exist" |
| `structure` | text not null | the slide-by-slide shape |
| `why_it_works` | text not null default `''` | the craft rationale |
| `source_example` | text not null default `''` | what post or account this came from |
| `brand_fit` | text not null default `''` | what kind of brand can carry it |
| `screenshot_url` | text not null default `''` | the Cloudinary image it was drafted from |
| `origin` | text not null, check in (`observed`, `invented`) | see §3.2 |
| `shared` | boolean not null default `false` | `true` = visible to every tenant |
| `active` | boolean not null default `true` | retire a weak entry without deleting it |
| `created_at` / `updated_at` | timestamptz | standard, with the existing `set_updated_at` trigger |

**RLS.** Read where `shared or auth.uid() = user_id`. Insert and update only where `auth.uid() = user_id`, with a `with check` clause that additionally requires `shared = false`.

Two consequences, both intended:

- **`shared` is never settable through the app.** Promoting a format to the shared library is a manual `update` in Supabase — the same way migrations are already applied by hand here. That is zero admin infrastructure for a gate that should be deliberate, and when user-capture arrives the same flip is already a moderation queue.
- **A shared row is immutable from the app**, including for its author, because any app-issued update must leave `shared = false` and would therefore fail the check. Editing a shared format is a SQL edit. Accepted: the shared set is small and curated.

**Deliberately not included:** `evidence` metrics, a `scraped` origin, or any other scraper column. They would be empty constants today. This repo has absorbed sixteen migrations without pain; one more when the scraper lands is cheaper than carrying dead fields through this build.

### 3.2 `origin` distinguishes two genuinely different kinds of row

- **`observed`** — a real post a human saw work, captured through §5. Carries a human vouch.
- **`invented`** — model-derived, promoted from a suggestion that stuck (§6).

The suggestion prompt **prefers `observed` over `invented`** when both fit, so a handful of real seeds punch above their count.

`scraped` joins the check constraint in project 2, and is the only origin that will ever carry verified performance data.

### 3.3 The provenance seam

`categories.source_format_id uuid null references formats(id) on delete set null`.

This is load-bearing beyond this feature. The product direction has Series carrying `format_id` **as provenance only**, with the approved translation stored verbatim so that re-deriving cannot silently change behavior. That is already exactly what happens here: the suggestion writes real values into the category's own columns, and `source_format_id` records only where they came from. The later object-model split inherits a column that is already correct.

## 4. `POST /api/categories/suggest`

Request `{ excludeConcepts?: string[], excludeFormatIds?: string[] }` → response `{ suggestionId, formatId: string | null, rationale, draft, sample }`. One structured-output call, BYOK via `requireAnthropicKey`, `maxDuration = 120`.

- **`draft`** reuses the wizard's existing `DraftTurnOutput` shape exactly (`name`, `style_guide`, `output_format`, `post_type`, `role_guides`, `caption_guide`, `images_per_carousel`, `aspect_ratio`, `assistant_message`), so it drops into the live panel with zero adaptation.
- **`sample`** is the fully-worked example: `concept`, `slides[{role, text, visual}]` matching the existing `Slide` shape, and `caption`.
- **`rationale`** is two sentences — why the structure works, and why it fits this brand, citing an actual proof point.
- **`formatId`** is the library entry the suggestion was built on, or `null` when the model invented one.
- **`excludeConcepts` / `excludeFormatIds`** carry what has already been shown this session, so "suggest a different one" produces a genuinely different format rather than a rephrase.

The route loads visible formats (`(shared or own) and active`) and renders them into the prompt as a menu. Brand context comes from the shared `brandBlock`, so proof points, standing, palette, and type are already in scope.

**The empty-library invariant:** with no visible formats the prompt must be byte-identical to the no-library version. Asserted with an exact `toBe`, the same invariant style that caught real bugs in `brandBlock`.

## 5. The honesty constraint, narrowed but not deleted

Neither a curated nor an invented format carries verified performance data. **Hand-seeding does not buy currency.** The prompt therefore still:

- **Forbids currency claims.** No "this is trending right now", no invented platform statistics, no named accounts it cannot verify.
- **Requires the rationale to be craft plus fit.** Craft: why the structure works mechanically ("a myth-bust opens a curiosity gap the payoff closes, which is why it survives platform churn"). Fit: why it suits *this* brand, naming a real proof point or standing entry.
- **Requires the sample to use the brand's actual material.** A sample built on invented claims is worse than no sample; it teaches the user the system doesn't know them.

**The single relaxation:** when a suggestion is built on an `observed` format, the rationale may name that entry's `source_example` concretely, because a human vouched for it. It still may not attach metrics or claim currency.

Lifting the constraint properly requires verified engagement data, which only the scraper provides. That is the strongest argument for building it, and it is why §13 keeps the hand-off cheap.

## 6. The invent path writes back

When a suggestion the model invented is one the user actually engages with, the format itself is saved rather than evaporating.

At suggest time, when `formatId` is null, the route stores the model's own description of the format it conceived on the log row (§7) as `invented_format` jsonb — `{name, structure, why_it_works, brand_fit}`. Storing the model's description rather than reconstructing one later from `categories` columns keeps what it actually conceived, and keeps the client out of it.

On **first persist only** (the insert path in the existing draft route, never a subsequent turn), the route reads the suggestion row by `suggestionId` — RLS-scoped to the caller — and:

1. If `formatId` is set, stamps `categories.source_format_id = formatId`.
2. If `formatId` is null, inserts a `formats` row from `invented_format` with `origin = 'invented'`, `shared = false`, and stamps `source_format_id` to it.
3. Stamps `format_suggestions.category_id`.

So the library grows from ordinary use. The formats picked repeatedly are the shortlist worth promoting to `shared`.

**Honest cost:** the library gets noisier than a purely curated one, and a tenant who re-rolls heavily accumulates junk. Mitigated by `active` and by invented rows never escaping their tenant — but "number of rows in `formats`" stops being a quality metric, and any future ranking must key off conversion, not count.

## 7. What gets recorded

`format_suggestions`: `id`, `user_id`, `format_id` (nullable, `on delete set null`), `concept`, `invented_format` jsonb (nullable, §6), `category_id` (nullable, `on delete set null`), `created_at`. Standard owner-only RLS.

One insert per suggestion, written **at suggest time**, before engagement. This is a deliberate deviation from §8: impressions are the entire point, so a re-rolled suggestion must leave a trace. It creates no category, so it does not litter Config.

It buys the ability to distinguish a format shown 100 times converting 5 from one shown 5 times converting 5. It has **no read surface in this project** — it is queried directly in Supabase. Included because it is a single insert in a route already making an LLM call, and re-roll behavior is the one signal that cannot be reconstructed later.

## 8. Persistence deviates from the wizard, deliberately

The wizard upserts an inactive category on turn 1. A suggestion does **not** persist a category until the user engages with it — otherwise every re-roll litters Config with abandoned categories. The suggestion is held client-side; the first real turn (accepting, or editing anything) persists it through the existing draft route, after which it is an ordinary wizard conversation.

Re-rolling replaces the held suggestion and never creates a category row. It does create a `format_suggestions` row, per §7.

## 9. Authoring observed formats

`POST /api/formats/draft` accepts a screenshot (Cloudinary URL), a link, a pasted description, or any combination, and returns a draft format entry for review before saving. The wizard already uploads images and attaches them to vision turns, so this reuses that path rather than building a second one. Saved entries get `origin = 'observed'`.

The surface is a small list-and-editor at `/config/formats`: the tenant's own formats plus the shared ones read-only, with an "add from a screenshot" affordance.

**Why this shape:** the scraper is a third caller of the same drafting function — scraped post content in, format entry out, `origin = 'scraped'`. And exposing capture to all tenants rather than just Rayyan is a permissions change, not a feature.

## 10. Surfaces

- **Onboarding step 2** offers "Build my own" (existing link) and "Suggest one for me".
- **Config** gets "✨ Suggest one" beside the existing "✨ Draft with AI".
- Both link to `/config/draft?suggest=1`. One implementation.

## 11. Error handling

- **Suggestion call failure:** inline error in the wizard with a retry, falling back to the ordinary blank drafting conversation so the user is never stuck. Upstream LLM errors surface through `friendlyLlmError` (merge `7566247`) like every other LLM surface.
- **No brand profile, or one with an empty `business_name`:** the suggest entry points are disabled with a note pointing at brand setup — a suggestion built on nothing is the generic output this feature exists to avoid.
- **A brand with no extracted palette or fonts** is a normal case, not an error: `normalizeHex` handles hex and `rgb()` only, so a Tailwind v4 site (oklch by default) yields near-zero color candidates. `brandBlock` already omits the visual-identity block entirely when all three fields are empty, and the suggestion prompt must not assert a palette it was not given. Asserted in tests.
- **A malformed structured output** (missing `sample`, wrong slide shape) is treated as a failed suggestion and retried rather than partially rendered.
- **Writeback failure** must not fail the persist. A category that saved correctly is the user's work; a missing `formats` row is a lost analytics record. Log and continue.

## 12. Testing

No live-LLM tests, consistent with the repo.

- **Prompt builder:** brand material present; formats rendered when present and cleanly absent when the library is empty; `observed` preferred over `invented`; `excludeConcepts` and `excludeFormatIds` rendered when supplied and omitted when empty; currency claims forbidden on both the library and invent paths; no palette asserted when the brand has none.
- **The empty-library invariant**, as an exact `toBe` against the no-library prompt (§4).
- **Sample validation:** the sample's slide array validated against the existing `validateSlideShape` rules for its `post_type` (narrative → hook/beats/payoff; independent → one `single` slide), so a malformed sample is caught rather than rendered.
- **Seeding logic:** a suggestion response maps to a first assistant turn in the wizard's existing `DraftTurn` shape.
- **Writeback:** an invented suggestion that persists creates exactly one `origin = 'invented'`, `shared = false` row and stamps `source_format_id`; one drawn from the library creates no format row and stamps the existing id; a second turn on the same category creates nothing further.
**RLS is verified by hand, not by test.** Every test in this repo is a pure-function unit — there is no Supabase client, no fixture database, and no integration harness, and standing one up is not in this project's scope. The policies in §3.1 are therefore checked manually against the live database when the migration is applied, using the same by-hand workflow already used for every migration here. The plan must carry this as an explicit acceptance step with a written checklist, not leave it implied:

1. Tenant B cannot select tenant A's `shared = false` format.
2. Tenant B can select tenant A's `shared = true` format.
3. A tenant cannot insert or update any `formats` row with `shared = true`.
4. A tenant cannot update a row that is already `shared = true`, including their own.
5. A tenant cannot select another tenant's `format_suggestions` rows.

Point 4 is the one most likely to be wrong in a first draft, because it depends on the `with check` clause rather than the `using` clause.

## 13. Phasing

The plan should phase this. Phase 1 ships real value alone, because the empty library is a supported state.

**Phase 1 — suggestions, self-filling.** Migration (`formats`, `categories.source_format_id`, `format_suggestions`), the suggest endpoint, wizard seeding, both entry points, the suggestion log, and the §6 writeback. The library starts empty and the invent path carries everything; it begins accumulating from the first suggestion anyone keeps.

**Phase 2 — observed seeding.** `POST /api/formats/draft` and the `/config/formats` surface, so genuinely observed formats can enter and start outranking invented ones.

## 14. What the 2026-07-30 amendment changed

The original spec deferred the format library wholesale to project 2, and §9 asserted the library would later replace "only where the format comes from." That assertion was correct but unmechanized — nothing in the design made it true, and nothing accumulated in the meantime.

The amendment makes the seam real (§3.3), gives the library a source that requires no discipline from anyone (§6), and starts recording data that is unrecoverable if not captured at the moment it happens (§7). What it explicitly does **not** change: suggestions still work with an empty library, and §5's honesty constraint still stands, because a hand-curated library carries no more verified currency than an invented one.

## 15. Out of scope

- **The scraper** (project 2). This design is shaped so it lands as: a `scraped` value on the `origin` check, an `evidence` column for real metrics, and a third caller of §9's drafting function. The suggestion endpoint, the wizard, the seeding mechanism, and every consumer of `source_format_id` stay untouched.
- **User-facing capture** — a permissions change on an endpoint that will already exist.
- **Moderation tooling** beyond the manual `shared` flip.
- **Any read surface over `format_suggestions`.**
- **The full Brand/Format/Series split** (project 2). This lands `formats` early and leaves `categories` otherwise as-is.
- Proactive or scheduled series proposals (needs the cadence model — project 3).
- Multiple simultaneous suggestions and any comparison UI.
- Suggesting ideas *within* an existing post type; this suggests the post type itself.
