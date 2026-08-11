# Multi-Brand Accounts — Design Spec

**Date:** 2026-08-10
**Status:** approved for planning
**Depends on:** `brand_profiles` (`supabase/migrations/0006_byok_brand.sql`, extended by `0015_brand_material.sql` and `0016_brand_design_tokens.sql`); the per-user tenancy model (`0005_multi_tenant_foundation.sql`); `loadBrandContext` (`lib/athena/brand-context.ts`); `saveBrandProfileForUser` (`lib/brand-profile.ts`); `requireUser` (`lib/auth/require-user.ts`); the MCP route (`app/api/mcp/route.ts`); the onboarding flow (`app/(app)/onboarding/`).

## 1. Summary

One account currently means exactly one brand: `brand_profiles` is primary-keyed on `user_id`. In production, super{set}, Rewire, and Kana already share a single login, which means `loadBrandContext(userId)` returns super{set}'s row for every generation — **a Rewire idea is being prompted right now with super{set}'s voice, proof points, avoid-list, colors, and fonts.** This is not a missing convenience feature; it is wrong output shipping today.

This spec makes a brand a first-class object owned by an account, makes categories belong to a brand, and derives brand context from the category being acted on rather than from the account.

### Where this sits

This is project **A** of four scoped from the same feature list. The others are specced separately and are not blocked by this one:

- **B — Asset compositing.** Category overlays (already specced in `2026-07-30-category-overlays-design.md`), per-idea overlay *slots* for content that varies per post (e.g. a different speaker headshot on each post of an event series), background removal on asset upload, and photo treatments. Everything hangs off `category_id`, so B is unaffected by A's ordering.
- **C — Generative reference lists.** `categories.style_ref_url` becomes an ordered list, for pinning style with multiple examples, rendering a product/screenshot into a scene, or supplying a layout reference.
- **D — Quick wins.** Image download from the gallery; password reset. Independent of everything.

The B/C split follows one rule established during design: **content that must be exact is composited; content that may be approximate is generated.** A real named person's face is never a generative reference — `gpt-image-2` produces a likeness, and a likeness of a named speaker on a promo is a liability. That case belongs to B's overlay slots.

## 2. Data model

`brand_profiles` becomes the brands table. It already carries exactly the right columns; only its primary key is wrong. Reshaping it in place means no new table, no data copy, and no dual-write window.

```sql
-- brand_profiles: user_id PK -> id PK, user_id demoted to owner FK
alter table brand_profiles add column id uuid not null default gen_random_uuid();
alter table brand_profiles drop constraint brand_profiles_pkey;
alter table brand_profiles add primary key (id);
alter table brand_profiles add column is_default boolean not null default false;
create index brand_profiles_user_idx on brand_profiles(user_id);
alter table brand_profiles
  add constraint brand_profiles_user_name_unique unique (user_id, business_name);

-- categories gain a brand owner
alter table categories add column brand_id uuid references brand_profiles(id) on delete cascade;
create index categories_brand_idx on categories(brand_id);
```

The existing RLS policy on `brand_profiles` (`owner all`, `auth.uid() = user_id`) is unchanged and still correct — ownership is still by user, there are just now several rows per user.

`unique (user_id, business_name)` exists so the MCP `brand` argument can resolve by name (§6). Two brands on one account may not share a display name.

**`categories.key` uniqueness is unchanged.** It stays `unique (user_id, key)` per `0005`, and the composite foreign keys `ideas(user_id, category_key)` and `posts(user_id, category_key)` are left exactly as they are. This was a deliberate choice over per-brand key namespaces: it avoids dropping and rebuilding two foreign keys and avoids adding `brand_id` to `ideas` and `posts`, at the cost of category keys needing to be distinct across brands within an account (`superset_speaker_promos`, `rewire_speaker_promos`). It also has a large payoff in §6 — a category key remains globally unambiguous within an account, so any MCP tool addressing a category by key needs no brand argument at all.

**`ideas`, `generations`, `posts`, and `post_images` gain nothing.** Each is reached through a category or an idea that already resolves to a brand.

## 3. Resolving the active brand

Two distinct resolution paths, and keeping them distinct is the point of the design.

### 3.1 Session brand — governs what you *see*

A cookie, set by the sidebar switcher through a server action, read by a new `requireActiveBrand()` helper living alongside `lib/auth/require-user.ts`. It returns the brand row, and it **validates on every read that the brand exists and belongs to `auth.uid()`** — an unvalidated brand id in a cookie is a tenant-isolation hole, not a cosmetic bug. A missing, stale, or foreign brand id falls back to the account's `is_default` brand; if no row is flagged default (possible only for an account created after the migration), it falls back to the oldest brand by `created_at`, and if the account has no brands at all the caller is routed to `/onboarding`.

A URL segment (`/b/[brandId]/…`) was considered and rejected: bookmarkable per-brand links and independent tabs are not worth relocating every route and rewriting every internal `<Link>` at this scale.

### 3.2 Category brand — governs what gets *prompted*

**The session brand must never determine brand context for generation.** Every generation path resolves brand from `category.brand_id` on the category being acted on.

This is what structurally eliminates the class of bug this project exists to fix. Switching brands mid-generation cannot poison a prompt; a cron-triggered poll or an MCP call with no session at all still resolves correctly; and there is no code path where "which brand is selected" and "which brand's content is being made" can disagree.

## 4. Rewriting the read path

`loadBrandContext(userId)` becomes `loadBrandContext(brandId)`. Its 14 call sites split three ways.

**Category already in hand — a one-line change, no additional query.** These are where the production bug lives.

| Site | Notes |
|---|---|
| `app/api/posts/rewrite-caption/route.ts:32` | `rewriteCaptionForUser` already loads the category above the call |
| `app/api/posts/adapt-caption/route.ts:34` | same shape |
| `lib/athena/preview.ts:51` | Test Run |
| `lib/style-ref-jobs.ts:35` | style-ref generation |
| `lib/athena/generate-ideas.ts:50` | idea generation |
| `app/(app)/post/[ideaId]/page.tsx:105` | idea → `category_key` → category |

**No category exists yet** — a new category is being drafted or suggested, so there is nothing to derive from. These take the session brand:

- `app/api/categories/draft/route.ts:64`
- `app/api/categories/draft/style-ref/route.ts:41`
- `app/api/categories/suggest/route.ts:48`

**View pages** — session brand: `app/(app)/config/page.tsx:28`, `app/(app)/ideas/page.tsx:19`, `app/(app)/onboarding/page.tsx:11`.

**MCP** — explicit `brand` argument or category-derived, per §6.

### 4.1 List filtering

Because `ideas`, `generations`, and `posts` do not carry `brand_id` (§2), pages scoped to the active brand filter through the brand's categories: load the brand's category keys, then constrain with `.in("category_key", keys)`. This applies to the Ideas queue and the Gallery. A brand with no categories yields an empty key list, which must render as an empty state rather than an unfiltered query.

## 5. UI

**Sidebar.** A brand switcher above `NavLinks` in `app/(app)/layout.tsx`. Selecting a brand calls a server action that sets the cookie, then `router.refresh()`.

**Config** splits into two bands. Account-level, above: API keys (`KeysSection`), Buffer connections (`ConnectionsSection`), MCP tokens, and the format library link. Brand-level, below, headed by the active brand's name: the brand profile (`BrandSection`) and the category list (`CategoryManager`), filtered to `brand_id`.

**Adding a brand.** "Add brand" routes to `/onboarding`, which stops being a once-per-account event and becomes the per-brand setup flow it already functionally is: paste a URL → extraction fills description/audience/voice/colors/fonts → suggested post types propose categories → each gets an auto-generated style ref. On completion the new brand becomes the session brand.

**Landmine — `saveBrandProfileForUser`.** It currently upserts with `onConflict: "user_id"` (`lib/brand-profile.ts:22`). Left unchanged, creating a second brand silently overwrites the first. It must become id-keyed (insert for a new brand, update by `id` for an existing one) in the same change that makes a second brand reachable. This is the single highest-risk edit in the project.

## 6. MCP

Category keys stay unique per account (§2), so **every tool that addresses a category by key needs no change** — brand is derived from that category. That covers `generate_ideas`, `list_ideas`, `get_idea`, `get_category`, `update_category`, `delete_category`, `clear_role_ref_url`, `submit_image_generation`, `resubmit_slide`, `rewrite_caption`, `adapt_caption`, `schedule_post`, `create_manual_idea`, `set_idea_decision`, `generate_style_ref`, and `get_style_ref_job`.

Five tools have no category in scope and gain an optional `brand` argument: `get_brand_profile`, `update_brand_profile`, `extract_brand_from_source`, `create_category`, `draft_category_turn`.

One new tool: `list_brands`, returning id, `business_name`, and `is_default`.

**Resolution rule.** The argument accepts a brand name, matched case-insensitively against `business_name` (the model naturally has the name, not a uuid).

- Account has exactly one brand → the argument is optional and resolves to it.
- Account has two or more and the argument is omitted → **error, naming the available brands.**
- Name matches nothing → error listing available brands.

Silently defaulting when several brands exist would reintroduce the exact failure this project removes, in the one surface where a human is least likely to notice it. There is no default-on-ambiguity path.

## 7. Migration and rollout

Migration `0020_multi_brand.sql`, in order:

1. Reshape `brand_profiles` per §2 (add `id`, swap PK, add `is_default`, add the name-uniqueness constraint, index `user_id`).
2. Mark every existing row `is_default = true` — one per account today, by construction.
3. Create a placeholder brand, **also `is_default = true`**, for any account that owns categories but has no `brand_profiles` row, so step 5's `not null` cannot fail. The flag must be set here rather than relying on step 2, which has already run.
4. Add `categories.brand_id` **nullable**.
5. Backfill `categories.brand_id` from each account's single brand, then `set not null` and index.

Post-condition to assert before `set not null`: every account owning at least one category has exactly one `is_default` brand, and no category has a null `brand_id`.

**Rollout sequencing is load-bearing.** All 14 `brand_profiles` reads currently use `.maybeSingle()`, which stops being correct the moment an account holds two rows. Therefore the migration, the read-path rewrite (§4), and the switcher (§5) ship in a single deploy, and **"Add brand" is the last thing enabled** — no account can hold a second brand before the code that handles it is live.

## 8. Testing

Pure-logic unit tests, matching this repo's convention of testing the logic around image/LLM work rather than the work itself:

- **MCP brand resolution** — zero brands, exactly one (argument omitted resolves), several with the argument omitted (errors), several with a matching name, a non-matching name, and case-insensitive matching.
- **Session brand validation** — valid id, absent cookie, stale id, and an id belonging to another user; each falls back to the default brand rather than leaking or throwing.
- **Category-key filtering** — a brand with categories, and a brand with none (must produce an empty result, never an unfiltered one).
- **Schedule bucketing** (§9) — fixed-time vs. queue partitioning and date grouping.

## 9. Cross-brand schedule page

A new `/schedule`, deliberately **outside** the switcher's scope — the one page that shows every brand at once. It reads `posts` joined to `categories` for a per-row brand badge, in two buckets:

- **Scheduled** — `scheduled_at is not null`, grouped by date.
- **In queue** — `scheduled_at is null`, meaning the post rides Buffer's own queue (`0013_post_scheduling.sql`). Listed without a time.

Resolving real queue times would require a Buffer API call per connection on every page load. Out of scope for v1; the honest "in queue" state is shown instead.

## 10. Out of scope

- **Per-post brand override.** A category is the brand choice; nothing selects a brand at the individual post level.
- **Moving a category between brands.** Its ideas, generations, and posts would have to move with it.
- **Per-brand format library.** `formats` stays account-level and shared across brands: a post structure is a structure, and the existing `brand_fit` column already carries the "does this suit us" judgment. Deliberate call, not an oversight.
- **Per-brand Buffer connections.** Connections stay account-level; categories already select specific channels within a connection.
- **Per-brand API keys.** BYOK credentials are the account holder's, not a brand's.
- **Teams / multiple users per brand.** Ownership remains one `user_id` per brand.
- **Real Buffer queue times on `/schedule`** (§9).
