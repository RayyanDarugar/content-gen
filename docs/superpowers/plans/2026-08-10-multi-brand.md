# Multi-Brand Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one account own several brands, so a category's brand — not the account — determines the voice, proof points, and colors injected into every prompt.

**Architecture:** `brand_profiles` is reshaped in place from a `user_id`-keyed singleton into an id-keyed brands table; `categories` gains `brand_id`. Brand resolution splits in two: a validated cookie picks the *viewing* brand, while every generation path derives brand from the category it is acting on. See `docs/superpowers/specs/2026-08-10-multi-brand-design.md`.

**Tech Stack:** Next.js 16.2.10 (App Router, server actions), Supabase (Postgres + RLS), TypeScript, Vitest, Tailwind + shadcn/ui.

## Global Constraints

- **Next.js 16.2.10.** `cookies()` is **async** — always `const cookieStore = await cookies()`. `.set()`/`.delete()` may only be called from a Server Function (`"use server"`) or Route Handler, never during Server Component render. Read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md` before touching cookies. Per `AGENTS.md`, do not assume App Router APIs match your training data — check `node_modules/next/dist/docs/` first.
- **`"use server"` files publish every export as a POST-reachable endpoint.** Never export a `userId`-taking function from one. Authenticated wrappers live in `app/(app)/**/actions.ts`; the `*ForUser` cores live in plain `lib/` modules. This convention is documented at `lib/category-mutations.ts:6-18` and must be preserved.
- **`requireActiveBrand` is for pages; `getActiveBrand` is for Route Handlers and server actions.** `redirect()` throws `NEXT_REDIRECT`, which a page turns into a navigation but a Route Handler surfaces as an opaque server error. A `requireActiveBrand` call inside `app/api/**` is a defect.
- **Every Supabase query filtered by id must also filter by the tenant.** `.eq("id", x).eq("user_id", userId)` — never `.eq("id", x)` alone. See `lib/style-ref-jobs.ts:25-31` for why.
- **Tests are Vitest, pure-logic only.** `npm run test`. This repo tests the logic *around* image/LLM work, never live encoding or network calls. Test files live flat in `tests/<name>.test.ts`.
- **Migrations are applied manually against Supabase by the repo owner**, not by any script in this plan. A task that depends on a migration must say so and stop.
- **Do not enable multi-brand creation before Task 15.** Every `brand_profiles` read still uses `.maybeSingle()` until Task 8; a second brand row existing before then returns arbitrary rows. Tasks 1–14 must leave every account at exactly one brand.
- **No new UI is written before the user has seen it.** Tasks 9, 10, and 14 each open with a Step 0 that renders mockups in the Prime Radiant visual companion (`superpowers:brainstorming`'s `scripts/start-server.sh`) and waits for the user's pick. The approved mockup is the specification for that task's markup — do not substitute your own layout. This applies to any other visible surface these tasks introduce.
- Commit after every task. Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`).

## Deviations from the spec

Two things surfaced during planning that the spec does not describe. Both are incorporated below.

1. **`generateIdeas` accepts `categoryKey: "ALL"`**, which loads every active category and builds one prompt from a single brand context (`lib/athena/generate-ideas.ts:41-72`). Across brands that is unfixable by per-call derivation, so `generateIdeas` gains a `brandId` parameter and scopes its category query to it — "ALL" means "all of this brand's active categories". Consequence: the MCP `generate_ideas` tool needs the optional `brand` argument too (Task 13), making five brand-argument tools, not four.
2. **`extract_brand_from_source` does not need a brand argument.** Spec §6 lists it, but `app/api/brand/extract/route.ts` touches no tables at all — it extracts and returns fields, and the caller persists them. It is dropped from the brand-argument list.

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/0020_multi_brand.sql` | **create** — reshape `brand_profiles`, add `categories.brand_id`, backfill, assert post-conditions |
| `lib/types.ts` | **modify** — `BrandProfile` gains `id`/`is_default`; `Category` gains `brand_id` |
| `lib/brands.ts` | **create** — brand list query + the two pure resolution rules |
| `lib/auth/active-brand.ts` | **create** — cookie name, pure `selectActiveBrand`, `requireActiveBrand` |
| `app/(app)/brand-actions.ts` | **create** — `setActiveBrand` server action |
| `app/(app)/brand-switcher.tsx` | **create** — sidebar switcher client component |
| `app/(app)/schedule/page.tsx` | **create** — cross-brand schedule |
| `lib/schedule.ts` | **create** — pure post bucketing |
| `lib/athena/brand-context.ts` | **modify** — takes `brandId` |
| `lib/athena/generate-ideas.ts` | **modify** — `brandId` parameter, brand-scoped category query |
| `lib/brand-profile.ts` | **modify** — id-keyed save (the landmine) |
| `lib/category-mutations.ts` | **modify** — writes carry `brand_id` |
| `app/api/mcp/route.ts` | **modify** — `brand` argument on 5 tools, new `list_brands` |

---

## Task 1: Migration and types

**Files:**
- Create: `supabase/migrations/0020_multi_brand.sql`
- Modify: `lib/types.ts:163-177` (`BrandProfile`), `lib/types.ts:71-93` (`Category`)

**Interfaces:**
- Consumes: nothing.
- Produces: `BrandProfile` with `id: string` and `is_default: boolean`; `Category` with `brand_id: string`. Every later task relies on both.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0020_multi_brand.sql`:

```sql
-- supabase/migrations/0020_multi_brand.sql
-- Multi-brand accounts (spec 2026-08-10-multi-brand-design.md §2, §7).
--
-- brand_profiles is primary-keyed on user_id, so an account can hold exactly
-- one brand. In production several brands already share one login, which
-- means loadBrandContext() returns one brand's voice, proof points and colors
-- for every other brand's generations. This reshapes brand_profiles into the
-- brands table in place — no new table, no data copy, no dual-write window.

-- 1. user_id PK -> id PK; user_id demoted to a plain owner FK.
alter table brand_profiles add column id uuid not null default gen_random_uuid();
alter table brand_profiles drop constraint brand_profiles_pkey;
alter table brand_profiles add primary key (id);
alter table brand_profiles add column is_default boolean not null default false;
create index brand_profiles_user_idx on brand_profiles(user_id);

-- The MCP `brand` argument resolves by display name (spec §6), so two brands
-- on one account may not share one.
alter table brand_profiles
  add constraint brand_profiles_user_name_unique unique (user_id, business_name);

-- 2. Every existing row is its account's only brand, by construction.
update brand_profiles set is_default = true;

-- 3. An account owning categories but no brand_profiles row would fail step
--    5's not-null. Give it a placeholder. is_default is set HERE rather than
--    left to step 2, which has already run.
insert into brand_profiles (user_id, business_name, is_default)
select distinct c.user_id, 'My brand', true
from categories c
where not exists (select 1 from brand_profiles b where b.user_id = c.user_id);

-- 4. categories gain a brand owner, nullable until backfilled.
--    on delete cascade matches categories.user_id's existing behaviour. Note
--    that deleting a brand that still has ideas will fail rather than cascade:
--    ideas holds a composite FK into categories(user_id, key) with no cascade
--    (0005), which is a deliberate safety net. There is no delete-brand UI in
--    this project.
alter table categories add column brand_id uuid references brand_profiles(id) on delete cascade;

-- 5. Backfill from each account's single brand.
update categories c
set brand_id = b.id
from brand_profiles b
where b.user_id = c.user_id and b.is_default;

-- Post-condition (spec §7), asserted before the not-null so the failure
-- names the actual problem instead of surfacing as a constraint violation.
do $$
declare bad int;
begin
  select count(*) into bad from categories where brand_id is null;
  if bad > 0 then
    raise exception 'multi-brand backfill: % categories still have a null brand_id', bad;
  end if;

  select count(*) into bad from (
    select user_id from brand_profiles
    group by user_id
    having count(*) filter (where is_default) <> 1
  ) t;
  if bad > 0 then
    raise exception 'multi-brand backfill: % accounts lack exactly one default brand', bad;
  end if;
end $$;

alter table categories alter column brand_id set not null;
create index categories_brand_idx on categories(brand_id);
```

- [ ] **Step 2: Update the types**

In `lib/types.ts`, add two fields to `BrandProfile` (it currently starts with `user_id`):

```ts
export interface BrandProfile {
  id: string;
  user_id: string;
  is_default: boolean;
  business_name: string;
  business_description: string;
  audience: string;
  voice: string;
  avoid: string;
  proof_points: string[];
  standing: string[];
  colors: string[];
  fonts: string[];
  visual_notes: string;
  created_at: string;
  updated_at: string;
}
```

And add `brand_id` to `Category`, directly after `user_id`:

```ts
export interface Category {
  id: string;
  user_id: string;
  brand_id: string;
  key: string;
  // ...rest unchanged
}
```

- [ ] **Step 3: Fix the one fully-typed fixture**

`tests/brand.test.ts:77` declares `const brand: BrandProfile = { … }` — a complete literal, so two new required fields break it. Add them:

```ts
  const brand: BrandProfile = {
    id: "b1",
    user_id: "u1",
    is_default: true,
    business_name: "Acme",
    // ...rest unchanged
```

Every other `Category`/`BrandProfile` value in the codebase comes from a Supabase read cast with `as`, which new required fields do not break.

- [ ] **Step 4: Verify the project still compiles**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. If tsc names any *other* file constructing a complete `Category` or `BrandProfile` literal, add the new fields there too — do not loosen the interfaces to make it compile.

- [ ] **Step 5: Apply the migration**

**STOP.** Migrations are applied manually. Tell the repo owner: "0020 is ready — apply it to Supabase before Task 2." Do not proceed until confirmed applied.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0020_multi_brand.sql lib/types.ts
git commit -m "feat: brand_profiles becomes an id-keyed brands table"
```

---

## Task 2: Brand list and resolution rules

**Files:**
- Create: `lib/brands.ts`
- Test: `tests/brands.test.ts`

**Interfaces:**
- Consumes: `BrandProfile` (Task 1).
- Produces:
  - `pickDefaultBrand(brands: BrandProfile[]): BrandProfile | null`
  - `resolveBrandByName(brands: BrandProfile[], name?: string): BrandProfile` (throws)
  - `listBrandsForUser(userId: string): Promise<BrandProfile[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/brands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pickDefaultBrand, resolveBrandByName } from "@/lib/brands";
import type { BrandProfile } from "@/lib/types";

function brand(over: Partial<BrandProfile>): BrandProfile {
  return {
    id: "b1", user_id: "u1", is_default: false, business_name: "Acme",
    business_description: "", audience: "", voice: "", avoid: "",
    proof_points: [], standing: [], colors: [], fonts: [], visual_notes: "",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("pickDefaultBrand", () => {
  it("returns null when the account has no brands", () => {
    expect(pickDefaultBrand([])).toBeNull();
  });

  it("prefers the row flagged is_default", () => {
    const brands = [
      brand({ id: "b1", created_at: "2026-01-01T00:00:00Z" }),
      brand({ id: "b2", is_default: true, created_at: "2026-05-01T00:00:00Z" }),
    ];
    expect(pickDefaultBrand(brands)?.id).toBe("b2");
  });

  it("falls back to the oldest brand when nothing is flagged", () => {
    const brands = [
      brand({ id: "newer", created_at: "2026-05-01T00:00:00Z" }),
      brand({ id: "older", created_at: "2026-01-01T00:00:00Z" }),
    ];
    expect(pickDefaultBrand(brands)?.id).toBe("older");
  });
});

describe("resolveBrandByName", () => {
  const superset = brand({ id: "b1", business_name: "super{set}" });
  const rewire = brand({ id: "b2", business_name: "Rewire" });

  it("throws when the account has no brands", () => {
    expect(() => resolveBrandByName([], undefined)).toThrow(/no brands yet/);
  });

  it("resolves without a name when there is exactly one brand", () => {
    expect(resolveBrandByName([superset], undefined).id).toBe("b1");
  });

  it("refuses to guess when several brands exist and no name is given", () => {
    expect(() => resolveBrandByName([superset, rewire], undefined))
      .toThrow(/super\{set\}, Rewire/);
  });

  it("treats a blank name as absent", () => {
    expect(() => resolveBrandByName([superset, rewire], "   "))
      .toThrow(/Pass brand explicitly/);
  });

  it("matches a name case-insensitively and ignoring surrounding space", () => {
    expect(resolveBrandByName([superset, rewire], "  rewire ").id).toBe("b2");
  });

  it("lists the available brands when the name matches nothing", () => {
    expect(() => resolveBrandByName([superset, rewire], "Kana"))
      .toThrow(/Available: super\{set\}, Rewire/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/brands.test.ts`
Expected: FAIL — cannot resolve `@/lib/brands`.

- [ ] **Step 3: Write the implementation**

Create `lib/brands.ts`:

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { BrandProfile } from "@/lib/types";

// Every resolution below runs against a list that was fetched for one user.
// That is what makes cross-tenant selection structurally impossible rather
// than a check somebody has to remember: a brand id or name belonging to
// another account is simply not in the array being searched.

export function pickDefaultBrand(brands: BrandProfile[]): BrandProfile | null {
  if (brands.length === 0) return null;
  return (
    brands.find((b) => b.is_default) ??
    [...brands].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
  );
}

// The MCP resolution rule (spec §6). There is deliberately no
// default-on-ambiguity path: silently picking a brand when several exist
// would reinstate the exact bug this project removes, on the surface where a
// human is least likely to notice it.
export function resolveBrandByName(brands: BrandProfile[], name?: string): BrandProfile {
  if (brands.length === 0) {
    throw new Error("This account has no brands yet — set one up in the app before calling this tool.");
  }
  const names = brands.map((b) => b.business_name).join(", ");
  if (!name?.trim()) {
    if (brands.length === 1) return brands[0];
    throw new Error(`This account has ${brands.length} brands. Pass brand explicitly — one of: ${names}`);
  }
  const wanted = name.trim().toLowerCase();
  const match = brands.find((b) => b.business_name.trim().toLowerCase() === wanted);
  if (!match) throw new Error(`No brand named "${name}". Available: ${names}`);
  return match;
}

export async function listBrandsForUser(userId: string): Promise<BrandProfile[]> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("brand_profiles").select("*").eq("user_id", userId).order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as BrandProfile[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/brands.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/brands.ts tests/brands.test.ts
git commit -m "feat: brand list query and resolution rules"
```

---

## Task 3: Active-brand session helper

**Files:**
- Create: `lib/auth/active-brand.ts`, `app/(app)/brand-actions.ts`
- Test: `tests/active-brand.test.ts`

**Interfaces:**
- Consumes: `listBrandsForUser`, `pickDefaultBrand` (Task 2).
- Produces:
  - `ACTIVE_BRAND_COOKIE: string`
  - `selectActiveBrand(brands: BrandProfile[], cookieValue: string | undefined): BrandProfile | null`
  - `getActiveBrand(userId: string): Promise<BrandProfile | null>` — **for API routes and server actions.** Returns null for a brandless account.
  - `requireActiveBrand(userId: string): Promise<BrandProfile>` — **for pages only.** Redirects to `/onboarding` when the account has no brands.
  - `setActiveBrand(brandId: string): Promise<void>` — server action

**Two helpers, deliberately.** `redirect()` throws a `NEXT_REDIRECT` error, which a page turns into a navigation but a Route Handler surfaces as a server error with no useful body. API routes must therefore use `getActiveBrand` and return their own JSON error. Pages use `requireActiveBrand`.

- [ ] **Step 1: Write the failing test**

Create `tests/active-brand.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectActiveBrand } from "@/lib/auth/active-brand";
import type { BrandProfile } from "@/lib/types";

function brand(over: Partial<BrandProfile>): BrandProfile {
  return {
    id: "b1", user_id: "u1", is_default: false, business_name: "Acme",
    business_description: "", audience: "", voice: "", avoid: "",
    proof_points: [], standing: [], colors: [], fonts: [], visual_notes: "",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const superset = brand({ id: "b1", is_default: true });
const rewire = brand({ id: "b2", created_at: "2026-06-01T00:00:00Z" });

describe("selectActiveBrand", () => {
  it("returns the brand the cookie names", () => {
    expect(selectActiveBrand([superset, rewire], "b2")?.id).toBe("b2");
  });

  it("falls back to the default brand when there is no cookie", () => {
    expect(selectActiveBrand([superset, rewire], undefined)?.id).toBe("b1");
  });

  it("falls back to the default brand when the cookie is stale", () => {
    expect(selectActiveBrand([superset, rewire], "deleted-brand")?.id).toBe("b1");
  });

  // The isolation property: another tenant's brand id is not in this user's
  // list, so it cannot be selected — no explicit ownership check to forget.
  it("ignores a cookie naming another account's brand", () => {
    expect(selectActiveBrand([superset], "someone-elses-brand")?.id).toBe("b1");
  });

  it("returns null when the account has no brands at all", () => {
    expect(selectActiveBrand([], "b1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/active-brand.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth/active-brand`.

- [ ] **Step 3: Write the helper**

Create `lib/auth/active-brand.ts`:

```ts
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listBrandsForUser, pickDefaultBrand } from "@/lib/brands";
import type { BrandProfile } from "@/lib/types";

export const ACTIVE_BRAND_COOKIE = "active_brand";

// Governs what the user SEES. It must never decide what gets prompted —
// generation paths derive brand from the category they are acting on
// (spec §3.2), so switching brands mid-generation cannot poison a prompt.
export function selectActiveBrand(
  brands: BrandProfile[],
  cookieValue: string | undefined,
): BrandProfile | null {
  const fromCookie = cookieValue ? brands.find((b) => b.id === cookieValue) : undefined;
  return fromCookie ?? pickDefaultBrand(brands);
}

// For API routes and server actions. redirect() throws NEXT_REDIRECT, which a
// page turns into a navigation but a Route Handler surfaces as an opaque
// server error — so those callers take the null and return their own error.
export async function getActiveBrand(userId: string): Promise<BrandProfile | null> {
  const brands = await listBrandsForUser(userId);
  const cookieStore = await cookies();
  return selectActiveBrand(brands, cookieStore.get(ACTIVE_BRAND_COOKIE)?.value);
}

// For pages only.
export async function requireActiveBrand(userId: string): Promise<BrandProfile> {
  const active = await getActiveBrand(userId);
  if (!active) redirect("/onboarding");
  return active;
}
```

- [ ] **Step 4: Write the server action**

Create `app/(app)/brand-actions.ts`:

```ts
"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import { listBrandsForUser } from "@/lib/brands";
import { ACTIVE_BRAND_COOKIE } from "@/lib/auth/active-brand";

// Every export of a "use server" module is a public POST endpoint, so this
// starts with requireUser(). selectActiveBrand already ignores a foreign
// brand id on read; the membership check here exists so switching to a brand
// you don't own fails loudly instead of silently landing on your default.
export async function setActiveBrand(brandId: string): Promise<void> {
  const user = await requireUser();
  const brands = await listBrandsForUser(user.id);
  if (!brands.some((b) => b.id === brandId)) throw new Error("unknown brand");

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_BRAND_COOKIE, brandId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/active-brand.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/auth/active-brand.ts "app/(app)/brand-actions.ts" tests/active-brand.test.ts
git commit -m "feat: validated active-brand cookie and switch action"
```

---

## Task 4: Retarget loadBrandContext to a brand id

**Files:**
- Modify: `lib/athena/brand-context.ts:5-8`, `lib/style-ref-jobs.ts:35`, `app/api/posts/rewrite-caption/route.ts:32`, `app/api/posts/adapt-caption/route.ts:34`, `app/api/categories/draft/route.ts:64`, `app/api/mcp/route.ts:59`
- Test: `tests/brand-context.test.ts`

**Interfaces:**
- Consumes: `listBrandsForUser`, `resolveBrandByName` (Task 2).
- Produces: `loadBrandContext(brandId: string): Promise<BrandContext>` — every later task calls this signature.

All five callers break at once when the signature changes, so they are one commit.

- [ ] **Step 1: Update the existing test**

Replace `tests/brand-context.test.ts` entirely. The mock must assert the query filters on `id`, not `user_id`:

```ts
import { describe, expect, it, vi } from "vitest";

const eqCalls: [string, string][] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: (column: string, value: string) => {
          eqCalls.push([column, value]);
          return {
            maybeSingle: async () => ({
              data: { business_name: "Athena", proof_points: ["p1"], colors: ["#fff"] },
            }),
          };
        },
      }),
    }),
  }),
}));

import { loadBrandContext } from "@/lib/athena/brand-context";

describe("loadBrandContext", () => {
  it("fills in every BrandContext field, defaulting missing ones", async () => {
    const brand = await loadBrandContext("brand-1");
    expect(brand.business_name).toBe("Athena");
    expect(brand.proof_points).toEqual(["p1"]);
    expect(brand.voice).toBe("");
    expect(brand.fonts).toEqual([]);
  });

  it("looks the brand up by its own id, not by the account", async () => {
    eqCalls.length = 0;
    await loadBrandContext("brand-1");
    expect(eqCalls).toEqual([["id", "brand-1"]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/brand-context.test.ts`
Expected: FAIL — the second test sees `["user_id", "brand-1"]`.

- [ ] **Step 3: Change the signature**

In `lib/athena/brand-context.ts`, change the parameter and the filter. Everything below the query is unchanged:

```ts
export async function loadBrandContext(brandId: string): Promise<BrandContext> {
  const supabase = createAdminSupabase();
  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").eq("id", brandId).maybeSingle();
  // ...unchanged field mapping
}
```

- [ ] **Step 4: Update the four category-derived callers**

Each already has its category loaded above the call — this is a one-word change in each, no new query.

`lib/style-ref-jobs.ts:35`:
```ts
const brand = await loadBrandContext(category.brand_id);
```

`app/api/posts/rewrite-caption/route.ts:32`:
```ts
const brand = await loadBrandContext(category.brand_id);
```

`app/api/posts/adapt-caption/route.ts:34`:
```ts
const brand = await loadBrandContext(category.brand_id);
```

`app/api/categories/draft/route.ts:64` — here `existing` may be null, because the first turn of a draft has no category yet. Add a `brandId` to the input instead of guessing:

```ts
export async function draftCategoryTurnForUser(
  userId: string,
  input: {
    turns: DraftTurn[];
    categoryId: string | null;
    styleRefUrl: string | null;
    suggestionId: string | null;
    brandId: string;
  },
): Promise<{ categoryId: string; assistantMessage: string; draft: NormalizedDraft }> {
```

and replace line 64 with:

```ts
  // An existing category owns the truth; a first turn has none, so the
  // caller's brand (session or MCP argument) decides where the new category
  // will land.
  const brandId = existing?.brand_id ?? input.brandId;
  const brand = await loadBrandContext(brandId);
```

Then pass `brandId` through to `insertDraft` (wired up in Task 7).

- [ ] **Step 5: Update the MCP caller**

`app/api/mcp/route.ts:57-60` — `get_brand_profile` gains no argument yet (Task 13 adds it), but must stop passing a user id. Add the import and rewrite the handler:

```ts
import { listBrandsForUser, resolveBrandByName } from "@/lib/brands";
```

```ts
    server.registerTool(
      "get_brand_profile",
      { title: "Get brand profile", description: "Read the current brand profile (name, voice, audience, proof points, colors/fonts)." },
      async () => {
        const brand = resolveBrandByName(await listBrandsForUser(userId));
        return { content: [{ type: "text", text: JSON.stringify(await loadBrandContext(brand.id)) }] };
      },
    );
```

Also update its one call site of `draftCategoryTurnForUser` (`app/api/mcp/route.ts`, the `draft_category_turn` tool) to pass a brand — for now, the resolved default:

```ts
      async ({ turns, categoryId, styleRefUrl, suggestionId }) => {
        const brand = resolveBrandByName(await listBrandsForUser(userId));
        return {
          content: [{
            type: "text",
            text: JSON.stringify(await draftCategoryTurnForUser(userId, {
              turns,
              categoryId: categoryId ?? null,
              styleRefUrl: styleRefUrl ?? null,
              suggestionId: suggestionId ?? null,
              brandId: brand.id,
            })),
          }],
        };
      },
```

- [ ] **Step 6: Update the web caller of draftCategoryTurnForUser**

In `app/api/categories/draft/route.ts`, the `POST` handler that wraps `draftCategoryTurnForUser` must supply the session brand. This is a Route Handler, so use `getActiveBrand` and return JSON — never `requireActiveBrand`, whose `redirect()` would surface here as an opaque server error:

```ts
import { getActiveBrand } from "@/lib/auth/active-brand";
```

and inside the handler, after `requireUser()`:

```ts
  const brand = await getActiveBrand(user.id);
  if (!brand) {
    return NextResponse.json({ error: "Set up a brand before drafting a post type." }, { status: 400 });
  }
```

passing `brandId: brand.id` into the `draftCategoryTurnForUser` input object.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc PASS, all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/athena/brand-context.ts lib/style-ref-jobs.ts app/api/posts/rewrite-caption/route.ts app/api/posts/adapt-caption/route.ts app/api/categories/draft/route.ts app/api/mcp/route.ts tests/brand-context.test.ts
git commit -m "refactor: loadBrandContext resolves a brand id, not an account"
```

---

## Task 5: Scope idea generation to a brand

**Files:**
- Modify: `lib/athena/generate-ideas.ts:41-72`, `app/api/ideas/generate/route.ts`, `app/api/mcp/route.ts` (`generate_ideas` tool)

**Interfaces:**
- Consumes: `loadBrandContext(brandId)` (Task 4), `requireActiveBrand` (Task 3).
- Produces: `generateIdeas(userId: string, brandId: string, categoryKey: string, count: number)` — note the new second positional parameter.

Rationale: `categoryKey === "ALL"` loads every active category and builds **one** prompt from **one** brand context. Across brands that is unfixable by per-category derivation, so the brand scopes the query instead — "ALL" means "all of this brand's active categories".

- [ ] **Step 1: Change the signature and scope the query**

In `lib/athena/generate-ideas.ts`, change the declaration:

```ts
export async function generateIdeas(
  userId: string,
  brandId: string,
  categoryKey: string,
  count: number,
) {
```

Replace the category query (currently line 41) so it is brand-scoped:

```ts
  // "ALL" means all of THIS BRAND's active categories. Without the brand
  // filter one prompt would carry several brands' categories against a
  // single brand context — the bug this project exists to remove.
  let query = supabase
    .from("categories").select("*")
    .eq("user_id", userId).eq("brand_id", brandId).eq("active", true);
  if (categoryKey !== "ALL") query = query.eq("key", categoryKey);
```

- [ ] **Step 2: Replace the inline brand read**

Delete the inline `brand_profiles` query and the hand-built `BrandContext` literal (currently lines 49-60) and replace with:

```ts
  const brand = await loadBrandContext(brandId);
```

Add the import at the top:

```ts
import { loadBrandContext } from "@/lib/athena/brand-context";
```

The now-unused `BrandContext` type import may be dropped if nothing else in the file uses it — check before removing.

- [ ] **Step 3: Update the web caller**

In `app/api/ideas/generate/route.ts`, resolve the session brand and pass it. Route Handler, so `getActiveBrand` + JSON error:

```ts
import { getActiveBrand } from "@/lib/auth/active-brand";
```

```ts
  const brand = await getActiveBrand(user.id);
  if (!brand) {
    return NextResponse.json({ error: "Set up a brand before generating ideas." }, { status: 400 });
  }
  const result = await generateIdeas(user.id, brand.id, categoryKey, count);
```

(Preserve whatever variable names and error handling the route already uses — only the `generateIdeas` arguments change.)

- [ ] **Step 4: Update the MCP caller**

In `app/api/mcp/route.ts`, the `generate_ideas` tool resolves the account's single brand for now; Task 13 adds the explicit argument:

```ts
      async ({ categoryKey, count }) => {
        const brand = resolveBrandByName(await listBrandsForUser(userId));
        return { content: [{ type: "text", text: JSON.stringify(await generateIdeas(userId, brand.id, categoryKey, count)) }] };
      },
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/athena/generate-ideas.ts app/api/ideas/generate/route.ts app/api/mcp/route.ts
git commit -m "feat: idea generation is scoped to one brand"
```

---

## Task 6: Remaining inline brand reads

**Files:**
- Modify: `lib/athena/preview.ts:50-60`, `app/(app)/post/[ideaId]/page.tsx:103-105`, `app/api/categories/suggest/route.ts:47-65`, `app/api/categories/draft/style-ref/route.ts:41`

**Interfaces:**
- Consumes: `loadBrandContext` (Task 4), `requireActiveBrand` (Task 3).
- Produces: nothing new.

Two of these have a category in hand (derive); two do not (session brand).

- [ ] **Step 1: preview.ts — derive from the category**

`generateSamplePreviewIdea(userId, category)` already receives the category. Replace the inline `brand_profiles` query and hand-built literal (lines 50-60ish) with:

```ts
  const brand = await loadBrandContext(category.brand_id);
```

Add `import { loadBrandContext } from "@/lib/athena/brand-context";` and delete the now-unused `supabase` local if nothing else in the function uses it.

- [ ] **Step 2: post page — derive from the category**

`app/(app)/post/[ideaId]/page.tsx` loads its category at line 31 (`category`). Replace lines 103-105:

```ts
  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").eq("id", category.brand_id).maybeSingle();
  const brand = brandRow as BrandProfile | null;
```

- [ ] **Step 3: suggest route — session brand**

In `app/api/categories/suggest/route.ts`, replace the `brand_profiles` query (line 47-48) with a session-brand lookup, keeping the existing "no business name" guard intact:

```ts
import { getActiveBrand } from "@/lib/auth/active-brand";
```

```ts
    const brandRow = await getActiveBrand(user.id);
    if (!brandRow?.business_name?.trim()) {
      return NextResponse.json(
        { error: "Add your business name in brand setup first — a suggestion needs something to build on." },
        { status: 400 });
    }
```

Route Handler, so `getActiveBrand` — the existing guard already returns the right 400, and a brandless account now falls into it naturally. The `BrandContext` literal built below stays exactly as-is: `brandRow` still has every field it reads.

- [ ] **Step 4: draft/style-ref route — session brand**

In `app/api/categories/draft/style-ref/route.ts`, replace the `brand_profiles` query at line 41. Route Handler, so `getActiveBrand`:

```ts
import { getActiveBrand } from "@/lib/auth/active-brand";
```

```ts
        const brandRow = await getActiveBrand(user.id);
        if (!brandRow) {
          return NextResponse.json({ error: "Set up a brand first." }, { status: 400 });
        }
```

Keep the surrounding field mapping unchanged. If the enclosing block is not positioned to return a response, throw `new Error("no brand")` instead and let the route's existing catch turn it into its usual error shape — match whatever that route already does.

- [ ] **Step 5: Confirm no account-scoped brand reads remain**

Run:
```bash
grep -rn 'from("brand_profiles")' lib app --include="*.ts" --include="*.tsx" | grep -v 'eq("id"'
```
Expected: only `lib/brands.ts` (the list query) and `lib/brand-profile.ts` (rewritten in Task 8). Anything else is a missed site — fix it before committing.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/preview.ts "app/(app)/post/[ideaId]/page.tsx" app/api/categories/suggest/route.ts app/api/categories/draft/style-ref/route.ts
git commit -m "refactor: remaining brand reads resolve a specific brand"
```

---

## Task 7: Category writes carry brand_id

**Files:**
- Modify: `lib/category-mutations.ts:20-45`, `app/(app)/config/actions.ts:25-29`, `app/api/categories/draft/route.ts` (`insertDraft`), `app/api/mcp/route.ts` (`create_category` tool)

**Interfaces:**
- Consumes: `requireActiveBrand` (Task 3), `resolveBrandByName` (Task 2).
- Produces: `createCategoryForUser(userId: string, brandId: string, fields: CategoryFields): Promise<void>` — new second positional parameter.

`brand_id` is deliberately **not** added to `CategoryFields`: it is not a user-editable field on the category form, and putting it there would let a form post move a category between brands (explicitly out of scope per spec §10).

- [ ] **Step 1: Add the parameter to createCategoryForUser**

In `lib/category-mutations.ts`:

```ts
export async function createCategoryForUser(
  userId: string,
  brandId: string,
  fields: CategoryFields,
): Promise<void> {
  validateCategoryFields(fields);
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("categories").insert({
    user_id: userId,
    brand_id: brandId,
    key: slugify(fields.name),
    // ...rest unchanged
  });
```

`updateCategoryForUser` is **not** changed — it must never write `brand_id`, so a category cannot change owner through an ordinary save.

- [ ] **Step 2: Update the server action**

In `app/(app)/config/actions.ts`:

```ts
import { requireActiveBrand } from "@/lib/auth/active-brand";
```

```ts
export async function createCategory(fields: CategoryFields) {
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  await createCategoryForUser(user.id, brand.id, fields);
  revalidatePath("/config");
}
```

- [ ] **Step 3: Update insertDraft**

In `app/api/categories/draft/route.ts`, thread the `brandId` computed in Task 4 into the insert:

```ts
async function insertDraft(
  supabase: Awaited<ReturnType<typeof createAdminSupabase>>,
  userId: string,
  brandId: string,
  draft: NormalizedDraft,
  styleRefUrl: string,
): Promise<string> {
  const base = slugify(draft.name);
  for (const key of [base, `${base}_2`, `${base}_3`, `${base}_4`, `${base}_5`]) {
    const { data, error } = await supabase
      .from("categories")
      .insert({
        user_id: userId,
        brand_id: brandId,
        key,
        ...draftColumns(draft),
        style_ref_url: styleRefUrl,
        post_caption: "",
        buffer_channel_id: "",
        active: false,
      })
      .select("id")
      .single();
    // ...rest of the loop unchanged
```

And update its call site in `draftCategoryTurnForUser`:

```ts
    id = await insertDraft(supabase, userId, brandId, draft, input.styleRefUrl ?? "");
```

- [ ] **Step 4: Update the MCP create_category tool**

In `app/api/mcp/route.ts`:

```ts
      async (fields) => {
        const brand = resolveBrandByName(await listBrandsForUser(userId));
        await createCategoryForUser(userId, brand.id, fields);
        return { content: [{ type: "text", text: "category created" }] };
      },
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. In particular `tests/draft-category.test.ts` and `tests/categories.test.ts` must still pass — if either constructs a category insert, update the fixture rather than the assertion.

- [ ] **Step 6: Commit**

```bash
git add lib/category-mutations.ts "app/(app)/config/actions.ts" app/api/categories/draft/route.ts app/api/mcp/route.ts
git commit -m "feat: new categories are created owned by a brand"
```

---

## Task 8: Make brand saves id-keyed (the landmine)

**Files:**
- Modify: `lib/brand-profile.ts:15-27`, `app/(app)/config/actions.ts:114-137`, `app/api/mcp/route.ts` (`update_brand_profile` tool)
- Test: `tests/brand-profile.test.ts`

**Interfaces:**
- Consumes: `BrandProfile` (Task 1).
- Produces:
  - `saveBrandProfileForUser(userId: string, brandId: string, fields: BrandProfileFields): Promise<void>` — updates one existing brand
  - `createBrandForUser(userId: string, fields: BrandProfileFields): Promise<string>` — inserts and returns the new brand id

**This is the highest-risk edit in the project.** The current implementation upserts with `onConflict: "user_id"` (`lib/brand-profile.ts:22-25`). Left unchanged, creating a second brand silently overwrites the first.

- [ ] **Step 1: Write the failing test**

Create `tests/brand-profile.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const calls: { op: string; payload: unknown; filters: [string, string][] }[] = [];

function builder(op: string, payload: unknown) {
  const filters: [string, string][] = [];
  const entry = { op, payload, filters };
  calls.push(entry);
  const chain = {
    eq(column: string, value: string) { filters.push([column, value]); return chain; },
    select() { return chain; },
    single: async () => ({ data: { id: "new-brand" }, error: null }),
    then(resolve: (v: { error: null }) => void) { resolve({ error: null }); },
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      update: (payload: unknown) => builder("update", payload),
      insert: (payload: unknown) => builder("insert", payload),
      upsert: (payload: unknown) => builder("upsert", payload),
    }),
  }),
}));

import { saveBrandProfileForUser, createBrandForUser } from "@/lib/brand-profile";

const fields = {
  business_name: "  Rewire  ", business_description: "", audience: "", voice: "", avoid: "",
  proof_points: [], standing: [], colors: [], fonts: [], visual_notes: "",
};

beforeEach(() => { calls.length = 0; });

describe("saveBrandProfileForUser", () => {
  it("updates one brand by id and never upserts on user_id", async () => {
    await saveBrandProfileForUser("user-1", "brand-9", fields);
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("update");
    expect(calls[0].filters).toEqual([["id", "brand-9"], ["user_id", "user-1"]]);
  });

  it("persists the name trimmed", async () => {
    await saveBrandProfileForUser("user-1", "brand-9", fields);
    expect((calls[0].payload as { business_name: string }).business_name).toBe("Rewire");
  });

  it("rejects a blank name", async () => {
    await expect(
      saveBrandProfileForUser("user-1", "brand-9", { ...fields, business_name: "  " }),
    ).rejects.toThrow(/name/i);
  });
});

describe("createBrandForUser", () => {
  it("inserts a new row and returns its id", async () => {
    const id = await createBrandForUser("user-1", fields);
    expect(calls[0].op).toBe("insert");
    expect(id).toBe("new-brand");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/brand-profile.test.ts`
Expected: FAIL — `createBrandForUser` is not exported, and `saveBrandProfileForUser` takes two arguments.

- [ ] **Step 3: Rewrite lib/brand-profile.ts**

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";

// Lives here, not in app/(app)/config/actions.ts: that file is "use server",
// so exporting a userId-taking, unauthenticated function from it would publish
// it as a callable server action any unauthenticated POST could reach. Callers
// must establish the user first (requireUser() in the action wrapper, bearer
// token in the MCP route).

export interface BrandProfileFields {
  business_name: string; business_description: string; audience: string; voice: string; avoid: string;
  proof_points: string[]; standing: string[]; colors: string[]; fonts: string[]; visual_notes: string;
}

// business_name is stored trimmed, not as supplied: the form path already
// trims, but the MCP `update_brand_profile` tool passes model-authored text
// straight through, and a name that only *validates* after trimming must
// also *persist* trimmed or the two callers disagree about the stored value.
function normalize(fields: BrandProfileFields): BrandProfileFields {
  if (!fields.business_name.trim()) throw new Error("Give the brand a name.");
  return { ...fields, business_name: fields.business_name.trim() };
}

// Updates ONE brand, addressed by its own id and filtered by the owner.
// This used to upsert on user_id, which was correct only while an account
// could hold exactly one brand — with several, that upsert overwrites a
// different brand than the caller meant.
export async function saveBrandProfileForUser(
  userId: string,
  brandId: string,
  fields: BrandProfileFields,
): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from("brand_profiles").update(normalize(fields))
    .eq("id", brandId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function createBrandForUser(
  userId: string,
  fields: BrandProfileFields,
): Promise<string> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("brand_profiles").insert({ user_id: userId, ...normalize(fields) })
    .select("id").single();
  if (error) {
    if (error.code === "23505") throw new Error("You already have a brand with that name.");
    throw new Error(error.message);
  }
  return (data as { id: string }).id;
}
```

- [ ] **Step 4: Update the two callers**

`app/(app)/config/actions.ts` — `saveBrandProfile` targets the active brand:

```ts
import { requireActiveBrand } from "@/lib/auth/active-brand";
```

```ts
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  try {
    await saveBrandProfileForUser(user.id, brand.id, {
      // ...unchanged field mapping
```

`app/api/mcp/route.ts` — `update_brand_profile`:

```ts
      async (fields) => {
        const brand = resolveBrandByName(await listBrandsForUser(userId));
        await saveBrandProfileForUser(userId, brand.id, fields);
        return { content: [{ type: "text", text: "brand profile updated" }] };
      },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/brand-profile.test.ts && npx tsc --noEmit`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/brand-profile.ts "app/(app)/config/actions.ts" app/api/mcp/route.ts tests/brand-profile.test.ts
git commit -m "fix: brand saves address one brand by id instead of upserting on user_id"
```

---

## Task 9: Sidebar brand switcher

**Files:**
- Create: `app/(app)/brand-switcher.tsx`
- Modify: `app/(app)/layout.tsx:8-20`

**Interfaces:**
- Consumes: `listBrandsForUser` (Task 2), `requireActiveBrand` (Task 3), `setActiveBrand` (Task 3).
- Produces: `<BrandSwitcher brands={BrandProfile[]} activeId={string} />`

- [ ] **Step 0: Mock up the switcher before writing it**

**Do not write component code yet.** Start the Prime Radiant visual companion and show the user two or three switcher treatments in the sidebar context (the existing sidebar is `w-52`, dark `bg-sidebar`, with the train icon + CONTENT/ENGINE wordmark above the nav):

```bash
/Users/rayyandarugar/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/brainstorming/scripts/start-server.sh --project-dir "/Users/rayyandarugar/Coding Projects/content-gen-app" --open
```

Show at minimum: a dropdown button under the wordmark, and a variant that folds the brand name into the wordmark itself. Get the user's pick before Step 1. Match the existing shadcn/ui components already in `components/ui/`.

- [ ] **Step 1: Build the client component**

Create `app/(app)/brand-switcher.tsx`. This is the structure; the visual treatment is whatever the user chose in Step 0:

```tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setActiveBrand } from "./brand-actions";
import type { BrandProfile } from "@/lib/types";

export function BrandSwitcher({ brands, activeId }: { brands: BrandProfile[]; activeId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const active = brands.find((b) => b.id === activeId);

  // A single-brand account has nothing to switch between — showing a
  // disabled dropdown would be noise on the one screen every user sees.
  if (brands.length < 2) {
    return (
      <div className="px-1 pb-3 text-xs font-medium text-muted-foreground truncate">
        {active?.business_name}
      </div>
    );
  }

  function choose(id: string) {
    startTransition(async () => {
      await setActiveBrand(id);
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        className="mb-3 flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm hover:bg-sidebar-accent disabled:opacity-60"
      >
        <span className="truncate font-medium">{active?.business_name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {brands.map((b) => (
          <DropdownMenuItem key={b.id} onSelect={() => choose(b.id)} className="gap-2">
            <Check className={`size-3.5 ${b.id === activeId ? "opacity-100" : "opacity-0"}`} />
            <span className="truncate">{b.business_name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: Confirm the dropdown-menu primitive exists**

Run: `ls components/ui/dropdown-menu.tsx`
If missing, add it with the project's shadcn setup (`components.json` is present) rather than hand-rolling a menu.

- [ ] **Step 3: Wire it into the layout**

`app/(app)/layout.tsx` must become an async server component to resolve the user and brands:

```tsx
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TrainIcon } from "@/components/train-icon";
import { NavLinks } from "./nav-links";
import { BrandSwitcher } from "./brand-switcher";
import { requireUser } from "@/lib/auth/require-user";
import { listBrandsForUser } from "@/lib/brands";
import { getActiveBrand } from "@/lib/auth/active-brand";

// getActiveBrand, NOT requireActiveBrand: this layout wraps /onboarding, so a
// redirect-on-null here would send a brandless account to /onboarding, whose
// layout would redirect it again — an infinite loop. The layout tolerates a
// null brand and renders the sidebar without a switcher; the individual pages
// that genuinely need a brand are the ones that redirect.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const brands = await listBrandsForUser(user.id);
  const active = await getActiveBrand(user.id);

  return (
    <div className="flex min-h-screen">
      <aside className="w-52 shrink-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border p-4 flex flex-col gap-1">
        <div className="flex items-center gap-2 mb-6 px-1">
          <TrainIcon className="h-7 w-7 text-primary" />
          <div className="font-heading font-bold leading-tight tracking-wide">
            <div className="text-sm">CONTENT</div>
            <div className="text-sm text-primary -mt-0.5">ENGINE</div>
          </div>
        </div>
        {active && <BrandSwitcher brands={brands} activeId={active.id} />}
        <NavLinks />
        <form action="/auth/signout" method="post" className="mt-auto">
          <Button variant="ghost" size="sm" type="submit">Sign out</Button>
        </form>
      </aside>
      <main className="flex-1 p-6 bg-grid">{children}</main>
      <Toaster />
    </div>
  );
}
```

- [ ] **Step 4: Verify in the running app**

Run: `npm run dev`, sign in, confirm the sidebar renders the brand name and the app still loads every page. With one brand there is no dropdown — that is correct until Task 15.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/brand-switcher.tsx" "app/(app)/layout.tsx"
git commit -m "feat: sidebar brand switcher"
```

---

## Task 10: Config page brand scoping

**Files:**
- Modify: `app/(app)/config/page.tsx:12-49`

**Interfaces:**
- Consumes: `requireActiveBrand` (Task 3).
- Produces: nothing new.

- [ ] **Step 0: Mock up the account/brand split first**

**Do not write page code yet.** In Prime Radiant, show the user the Config page reorganised into an account band (API keys, Buffer connections, format library link) and a brand band headed by the active brand's name (brand profile, categories). Show at least two treatments — a visual divider with a section heading, versus two visually distinct cards. Get the pick before Step 1.

- [ ] **Step 1: Scope the reads**

In `app/(app)/config/page.tsx`, replace the account-wide brand and category reads:

```ts
import { requireActiveBrand } from "@/lib/auth/active-brand";
```

```ts
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  // ...keys/connections reads unchanged (they are account-level)
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("categories").select("*").eq("brand_id", brand.id).order("key");
```

and delete the `brand_profiles` query entirely, passing `brand` where `brandRow` was used:

```tsx
      <BrandSection brand={brand} />
      <ConnectionsSection groups={groups} />
      <CategoryManager
        categories={(data ?? []) as Category[]}
        groups={groups}
        brandDone={Boolean(brand.business_name.trim())}
        hasKieKey={status.kie}
      />
```

- [ ] **Step 2: Apply the chosen layout**

Reorganise the JSX into the account band and brand band the user picked in Step 0, with the brand band headed by `{brand.business_name}`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` then `npm run dev` and load `/config`. Confirm categories still list and the brand form still saves.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/config/page.tsx"
git commit -m "feat: config separates account settings from brand settings"
```

---

## Task 11: Ideas and Gallery brand scoping

**Files:**
- Create: `lib/scope.ts`
- Modify: `app/(app)/ideas/page.tsx:9-25`, `app/(app)/gallery/page.tsx:9-25`
- Test: `tests/scope.test.ts`

**Interfaces:**
- Consumes: `requireActiveBrand` (Task 3).
- Produces: `scopeToCategoryKeys<T extends { category_key: string }>(items: T[], keys: string[]): T[]`

`ideas` and `generations` carry no `brand_id` (spec §2), so both pages filter through the brand's category keys. The failure mode worth a test: a brand with **no** categories must yield nothing, not everything.

- [ ] **Step 1: Write the failing test**

Create `tests/scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scopeToCategoryKeys } from "@/lib/scope";

const items = [
  { id: "1", category_key: "SUPERSET_TIPS" },
  { id: "2", category_key: "REWIRE_NEWS" },
  { id: "3", category_key: "SUPERSET_TIPS" },
];

describe("scopeToCategoryKeys", () => {
  it("keeps only items whose category belongs to the brand", () => {
    expect(scopeToCategoryKeys(items, ["SUPERSET_TIPS"]).map((i) => i.id)).toEqual(["1", "3"]);
  });

  // The dangerous case: an empty key list must mean "this brand has nothing",
  // never "no filter applied".
  it("returns nothing when the brand has no categories", () => {
    expect(scopeToCategoryKeys(items, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scope.test.ts`
Expected: FAIL — cannot resolve `@/lib/scope`.

- [ ] **Step 3: Write the implementation**

Create `lib/scope.ts`:

```ts
// ideas/generations/posts carry no brand_id (spec §2) — they are scoped
// through the brand's categories. An empty key list means the brand owns no
// categories, which must produce an empty result rather than an unfiltered
// one; a `keys.length ? filter : items` shortcut would invert exactly that.
export function scopeToCategoryKeys<T extends { category_key: string }>(
  items: T[],
  keys: string[],
): T[] {
  const allowed = new Set(keys);
  return items.filter((i) => allowed.has(i.category_key));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/scope.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Scope the Ideas page**

In `app/(app)/ideas/page.tsx`:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { scopeToCategoryKeys } from "@/lib/scope";
```

```ts
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  const supabase = await createServerSupabase();

  const { data: catData } = await supabase
    .from("categories").select("*").eq("brand_id", brand.id).eq("active", true).order("key");
  const categories = (catData ?? []) as Category[];

  const { data } = await supabase
    .from("ideas").select("*").order("created_at", { ascending: false }).limit(200);
  const ideas = scopeToCategoryKeys((data ?? []) as Idea[], categories.map((c) => c.key));

  const brandMissing = !brand.business_name.trim();
```

Delete the `brand_profiles` query. Pass `categories` to `<ManualIdeaDialog categories={categories} />`.

- [ ] **Step 6: Scope the Gallery page**

In `app/(app)/gallery/page.tsx`:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { scopeToCategoryKeys } from "@/lib/scope";
```

```ts
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  const supabase = await createServerSupabase();

  const { data: catData } = await supabase
    .from("categories").select("key").eq("brand_id", brand.id);
  const keys = ((catData ?? []) as { key: string }[]).map((c) => c.key);

  const { data } = await supabase
    .from("ideas")
    .select("*, generations(*)")
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "generations", ascending: false })
    .limit(200);

  const ideas = scopeToCategoryKeys((data ?? []) as IdeaWithGenerations[], keys)
    .filter((i) => i.generations.length > 0);
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/scope.ts tests/scope.test.ts "app/(app)/ideas/page.tsx" "app/(app)/gallery/page.tsx"
git commit -m "feat: ideas and gallery are scoped to the active brand"
```

---

## Task 12: Onboarding creates a brand

**Files:**
- Modify: `app/(app)/onboarding/page.tsx:6-23`, `app/(app)/config/actions.ts`

**Interfaces:**
- Consumes: `createBrandForUser` (Task 8), `listBrandsForUser` (Task 2), `setActiveBrand` (Task 3).
- Produces: `createBrandAction(fields: BrandProfileFields): Promise<{ error?: string; ok?: boolean }>` — creates a brand and switches to it.

Onboarding stops being a once-per-account event. Its entry point for *additional* brands stays hidden until Task 15.

- [ ] **Step 1: Add the create-brand action**

In `app/(app)/config/actions.ts`:

```ts
import { createBrandForUser } from "@/lib/brand-profile";
import { setActiveBrand } from "@/app/(app)/brand-actions";
```

```ts
// Creating a brand and switching to it are one user intent: a new brand the
// user is not looking at is a confusing outcome.
export async function createBrandAction(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  try {
    const brandId = await createBrandForUser(user.id, {
      business_name: String(formData.get("business_name") ?? "").trim(),
      business_description: String(formData.get("business_description") ?? "").trim(),
      audience: String(formData.get("audience") ?? "").trim(),
      voice: String(formData.get("voice") ?? "").trim(),
      avoid: String(formData.get("avoid") ?? "").trim(),
      proof_points: parseBrandList(formData.get("proof_points")),
      standing: parseBrandList(formData.get("standing")),
      colors: parseBrandList(formData.get("colors")),
      fonts: parseBrandList(formData.get("fonts")),
      visual_notes: String(formData.get("visual_notes") ?? "").trim(),
    });
    await setActiveBrand(brandId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/config");
  return { ok: true };
}
```

- [ ] **Step 2: Scope the onboarding page**

In `app/(app)/onboarding/page.tsx`, replace the account-wide reads. An account with no brands at all reaches this page via `requireActiveBrand`'s redirect, so `brand` may legitimately be null here — keep the null-tolerant shape the component already has:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { listBrandsForUser, pickDefaultBrand } from "@/lib/brands";
import { cookies } from "next/headers";
import { ACTIVE_BRAND_COOKIE, selectActiveBrand } from "@/lib/auth/active-brand";
```

```ts
  const user = await requireUser();
  const supabase = await createServerSupabase();

  // Not requireActiveBrand(): that redirects here when there are no brands,
  // which would loop. This page must tolerate a brandless account.
  const brands = await listBrandsForUser(user.id);
  const cookieStore = await cookies();
  const brand = selectActiveBrand(brands, cookieStore.get(ACTIVE_BRAND_COOKIE)?.value);

  const { data: catData } = await supabase
    .from("categories").select("*")
    .eq("brand_id", brand?.id ?? "00000000-0000-0000-0000-000000000000")
    .eq("active", true).order("key");
  const categories = (catData ?? []) as Category[];

  const { count: ideaCount } = await supabase
    .from("ideas").select("*", { count: "exact", head: true });
```

The `pickDefaultBrand` import is only needed if you use it directly — drop it if `selectActiveBrand` covers the page.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` then `npm run dev`, load `/onboarding`, confirm the three-step checklist still reflects reality.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/onboarding/page.tsx" "app/(app)/config/actions.ts"
git commit -m "feat: onboarding creates and activates a brand"
```

---

## Task 13: MCP brand arguments

**Files:**
- Modify: `app/api/mcp/route.ts`
- Test: `tests/mcp-brand.test.ts`

**Interfaces:**
- Consumes: `resolveBrandByName`, `listBrandsForUser` (Task 2).
- Produces:
  - `brandForUser(userId: string, name?: string): Promise<BrandProfile>` in `lib/brands.ts`
  - an optional `brand: z.string().optional()` input on `get_brand_profile`, `update_brand_profile`, `create_category`, `draft_category_turn`, and `generate_ideas`
  - a new `list_brands` tool

`extract_brand_from_source` is **not** in this list — `app/api/brand/extract/route.ts` touches no tables, so it has no brand to resolve.

This task's test exercises the MCP wiring, not the resolution rule — `resolveBrandByName` is already covered by `tests/brands.test.ts` (Task 2) and re-testing it here would be duplicated coverage with no red phase. What is genuinely untested is whether a tool actually *routes through* the resolver.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-brand.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BrandProfile } from "@/lib/types";

function brand(id: string, name: string): BrandProfile {
  return {
    id, user_id: "user-1", is_default: id === "b1", business_name: name,
    business_description: "", audience: "", voice: "", avoid: "",
    proof_points: [], standing: [], colors: [], fonts: [], visual_notes: "",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

const BRANDS = [brand("b1", "super{set}"), brand("b2", "Rewire")];

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: vi.fn(async (request?: Request) => {
    if (request?.headers.get("authorization") === "Bearer valid-token") return { id: "user-1" };
    throw new Error("unauthorized");
  }),
}));

// listBrandsForUser is stubbed; resolveBrandByName and brandForUser stay real,
// so this exercises the actual resolution the tools depend on.
vi.mock("@/lib/brands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/brands")>();
  return { ...actual, listBrandsForUser: vi.fn(async () => BRANDS) };
});

vi.mock("@/lib/athena/brand-context", () => ({
  loadBrandContext: vi.fn(async (brandId: string) => ({ business_name: `loaded:${brandId}` })),
}));

import { POST } from "@/app/api/mcp/route";

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const request = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const response = await POST(request as never);
  // Read the raw body rather than parsing: mcp-handler may frame the reply as
  // JSON or as an SSE data frame, and the assertions below only care that the
  // resolver's message reached the caller either way.
  return await response.text();
}

describe("MCP tools route through brand resolution", () => {
  it("refuses to guess when the account has several brands and none was named", async () => {
    const body = await callTool("get_brand_profile", {});
    expect(body).toContain("super{set}");
    expect(body).toContain("Rewire");
    expect(body).not.toContain("loaded:b1");
  });

  it("loads the named brand when the argument is supplied", async () => {
    const body = await callTool("get_brand_profile", { brand: "Rewire" });
    expect(body).toContain("loaded:b2");
  });

  it("reports an unknown brand name instead of falling back to the default", async () => {
    const body = await callTool("get_brand_profile", { brand: "Kana" });
    expect(body).toContain("Kana");
    expect(body).not.toContain("loaded:b1");
  });

  it("list_brands returns every brand on the account", async () => {
    const body = await callTool("list_brands", {});
    expect(body).toContain("super{set}");
    expect(body).toContain("Rewire");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp-brand.test.ts`
Expected: FAIL — `get_brand_profile` currently takes no `brand` argument and resolves the account's single brand, and `list_brands` does not exist.

If the failure is instead a transport error (empty body, or a 406 on the Accept header), fix the *request* in the test to match what `mcp-handler` expects and keep the assertions — they describe the behaviour under test and must not be weakened to whatever the current code happens to emit.

- [ ] **Step 3: Add the shared resolver**

In `lib/brands.ts`, add:

```ts
// Spec §6: one brand -> the argument is optional; several -> omitting it is
// an error naming the alternatives. Never a silent default. Lives here rather
// than inside the MCP route so it is reachable from a test without a request.
export async function brandForUser(userId: string, name?: string): Promise<BrandProfile> {
  return resolveBrandByName(await listBrandsForUser(userId), name);
}
```

- [ ] **Step 4: Add the brand argument to the five tools**

In `app/api/mcp/route.ts`, import `brandForUser` and give each of the five tools an optional `brand` input routed through it. Replace every `resolveBrandByName(await listBrandsForUser(userId), …)` call introduced in Tasks 4, 5, 7, and 8 with `brandForUser(userId, brand)`. `get_brand_profile`:

```ts
    server.registerTool(
      "get_brand_profile",
      {
        title: "Get brand profile",
        description: "Read one brand's profile (name, voice, audience, proof points, colors/fonts). Pass brand when the account has more than one.",
        inputSchema: z.object({ brand: z.string().optional() }),
      },
      async ({ brand }) => {
        const resolved = await brandForUser(userId, brand);
        return { content: [{ type: "text", text: JSON.stringify(await loadBrandContext(resolved.id)) }] };
      },
    );
```

`update_brand_profile` — add `brand: z.string().optional()` to its existing input object and:

```ts
      async ({ brand, ...fields }) => {
        const resolved = await brandForUser(userId, brand);
        await saveBrandProfileForUser(userId, resolved.id, fields);
        return { content: [{ type: "text", text: "brand profile updated" }] };
      },
```

`create_category` — `inputSchema: z.object({ brand: z.string().optional(), ...categoryFieldsShape })`:

```ts
      async ({ brand, ...fields }) => {
        const resolved = await brandForUser(userId, brand);
        await createCategoryForUser(userId, resolved.id, fields);
        return { content: [{ type: "text", text: "category created" }] };
      },
```

`draft_category_turn` — add `brand: z.string().optional()` to its input object and pass `brandId: (await brandForUser(userId, brand)).id`.

`generate_ideas` — add `brand: z.string().optional()`:

```ts
      async ({ categoryKey, count, brand }) => {
        const resolved = await brandForUser(userId, brand);
        return { content: [{ type: "text", text: JSON.stringify(await generateIdeas(userId, resolved.id, categoryKey, count)) }] };
      },
```

- [ ] **Step 5: Add list_brands**

```ts
    server.registerTool(
      "list_brands",
      { title: "List brands", description: "List every brand on this account. Use the business_name as the `brand` argument on other tools." },
      async () => {
        const brands = await listBrandsForUser(userId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(brands.map((b) => ({ id: b.id, business_name: b.business_name, is_default: b.is_default }))),
          }],
        };
      },
    );
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, including the existing `tests/mcp-route.test.ts` and `tests/mcp-tier2-gate.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add lib/brands.ts app/api/mcp/route.ts tests/mcp-brand.test.ts
git commit -m "feat: MCP brand argument and list_brands"
```

---

## Task 14: Cross-brand schedule page

**Files:**
- Create: `lib/schedule.ts`, `app/(app)/schedule/page.tsx`
- Modify: `app/(app)/nav-links.tsx:6-12`
- Test: `tests/schedule.test.ts`

**Interfaces:**
- Consumes: `Post` (`lib/types.ts`).
- Produces:
  - `type ScheduleRow = { post: Post; brandName: string }`
  - `bucketSchedule(rows: ScheduleRow[]): { scheduled: { date: string; rows: ScheduleRow[] }[]; queued: ScheduleRow[] }`

This page deliberately **ignores** the active brand — it is the one cross-brand view (spec §9).

- [ ] **Step 0: Mock up the page before writing it**

**Do not write page code yet.** In Prime Radiant, show the user at least two layouts: a date-grouped list with a brand badge per row, and a column-per-brand board. Note that queue-riding posts have no time at all and need somewhere honest to live. Get the pick before Step 1.

- [ ] **Step 1: Write the failing test**

Create `tests/schedule.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bucketSchedule, type ScheduleRow } from "@/lib/schedule";
import type { Post } from "@/lib/types";

function row(id: string, scheduled_at: string | null, brandName: string): ScheduleRow {
  return {
    post: {
      id, user_id: "u1", category_key: "K", buffer_update_id: "", post_group_id: "",
      buffer_channel_id: "", scheduled_at, adapted_from_caption: "",
      buffer_channel_service: "linkedin", caption: "", status: "queued", error: "",
      idea_id: null, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
    } as Post,
    brandName,
  };
}

describe("bucketSchedule", () => {
  it("separates fixed-time posts from posts riding Buffer's own queue", () => {
    const result = bucketSchedule([
      row("a", "2026-08-12T15:00:00Z", "super{set}"),
      row("b", null, "Rewire"),
    ]);
    expect(result.scheduled.flatMap((d) => d.rows).map((r) => r.post.id)).toEqual(["a"]);
    expect(result.queued.map((r) => r.post.id)).toEqual(["b"]);
  });

  it("groups fixed-time posts by calendar date, earliest first", () => {
    const result = bucketSchedule([
      row("late", "2026-08-14T09:00:00Z", "Kana"),
      row("early", "2026-08-12T09:00:00Z", "super{set}"),
      row("same-day", "2026-08-12T17:00:00Z", "Rewire"),
    ]);
    expect(result.scheduled.map((d) => d.date)).toEqual(["2026-08-12", "2026-08-14"]);
    expect(result.scheduled[0].rows.map((r) => r.post.id)).toEqual(["early", "same-day"]);
  });

  it("orders posts within a day by time", () => {
    const result = bucketSchedule([
      row("pm", "2026-08-12T17:00:00Z", "A"),
      row("am", "2026-08-12T09:00:00Z", "B"),
    ]);
    expect(result.scheduled[0].rows.map((r) => r.post.id)).toEqual(["am", "pm"]);
  });

  it("returns empty buckets for no posts", () => {
    expect(bucketSchedule([])).toEqual({ scheduled: [], queued: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/schedule.test.ts`
Expected: FAIL — cannot resolve `@/lib/schedule`.

- [ ] **Step 3: Write the implementation**

Create `lib/schedule.ts`:

```ts
import type { Post } from "@/lib/types";

export type ScheduleRow = { post: Post; brandName: string };

export type ScheduleBuckets = {
  scheduled: { date: string; rows: ScheduleRow[] }[];
  queued: ScheduleRow[];
};

// A post with no scheduled_at rides Buffer's own queue (0013) — Buffer, not
// this app, decides when it goes out. Resolving the real time would cost a
// Buffer API call per connection on every page load, so it is shown honestly
// as "in queue" instead of guessed at.
export function bucketSchedule(rows: ScheduleRow[]): ScheduleBuckets {
  const queued = rows.filter((r) => !r.post.scheduled_at);
  const timed = rows
    .filter((r) => r.post.scheduled_at)
    .sort((a, b) => a.post.scheduled_at!.localeCompare(b.post.scheduled_at!));

  const byDate = new Map<string, ScheduleRow[]>();
  for (const r of timed) {
    const date = r.post.scheduled_at!.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), r]);
  }

  return {
    scheduled: [...byDate.entries()].map(([date, rows]) => ({ date, rows })),
    queued,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/schedule.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Build the page**

Create `app/(app)/schedule/page.tsx`, in the layout chosen in Step 0:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { bucketSchedule, type ScheduleRow } from "@/lib/schedule";
import { Badge } from "@/components/ui/badge";
import type { Post } from "@/lib/types";

// The one page that ignores the brand switcher (spec §9): its whole purpose
// is answering "is anything going out for Kana this week?" without switching.
export default async function SchedulePage() {
  const user = await requireUser();
  const supabase = await createServerSupabase();

  const { data: catData } = await supabase
    .from("categories").select("key, brand_id");
  const { data: brandData } = await supabase
    .from("brand_profiles").select("id, business_name").eq("user_id", user.id);

  const brandById = new Map(
    ((brandData ?? []) as { id: string; business_name: string }[]).map((b) => [b.id, b.business_name]),
  );
  const brandByKey = new Map(
    ((catData ?? []) as { key: string; brand_id: string }[])
      .map((c) => [c.key, brandById.get(c.brand_id) ?? "—"]),
  );

  const { data: postData } = await supabase
    .from("posts").select("*").neq("status", "failed")
    .order("scheduled_at", { ascending: true }).limit(200);

  const rows: ScheduleRow[] = ((postData ?? []) as Post[]).map((post) => ({
    post,
    brandName: brandByKey.get(post.category_key) ?? "—",
  }));
  const { scheduled, queued } = bucketSchedule(rows);

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Schedule</h1>
        <p className="text-sm text-muted-foreground">Every brand, in one place.</p>
      </div>

      {scheduled.length === 0 && queued.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing scheduled yet.</p>
      )}

      {scheduled.map((day) => (
        <section key={day.date} className="space-y-2">
          <h2 className="text-sm font-semibold">
            {new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, {
              weekday: "long", month: "short", day: "numeric",
            })}
          </h2>
          {day.rows.map(({ post, brandName }) => (
            <div key={post.id} className="flex items-center gap-3 rounded-xl border p-3">
              <Badge variant="outline">{brandName}</Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(post.scheduled_at!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </span>
              <span className="truncate text-sm">{post.caption || post.category_key}</span>
            </div>
          ))}
        </section>
      ))}

      {queued.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">In Buffer&rsquo;s queue</h2>
          <p className="text-xs text-muted-foreground">
            Buffer picks the time for these — no fixed slot is stored here.
          </p>
          {queued.map(({ post, brandName }) => (
            <div key={post.id} className="flex items-center gap-3 rounded-xl border p-3">
              <Badge variant="outline">{brandName}</Badge>
              <span className="truncate text-sm">{post.caption || post.category_key}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Add the nav entry**

In `app/(app)/nav-links.tsx`, add to the `nav` array after Post, importing `CalendarDays` from `lucide-react`:

```ts
  { href: "/schedule", label: "Schedule", icon: CalendarDays },
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run`, then `npm run dev` and load `/schedule`.

- [ ] **Step 8: Commit**

```bash
git add lib/schedule.ts tests/schedule.test.ts "app/(app)/schedule/page.tsx" "app/(app)/nav-links.tsx"
git commit -m "feat: cross-brand schedule page"
```

---

## Task 15: Enable brand creation

**Files:**
- Modify: `app/(app)/config/page.tsx` (add the "Add brand" control)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

This is the gate. Nothing before this point lets an account hold a second brand, which is what keeps Tasks 1–14 safe to ship incrementally.

- [ ] **Step 1: Confirm every precondition**

Run and read the output of each:

```bash
grep -rn '\.upsert(' lib app --include="*.ts" --include="*.tsx"
```
Expected: **exactly one match** — `app/(app)/config/actions.ts`, upserting `user_settings`. Any match writing `brand_profiles` means a brand write still goes through an upsert and adding a brand may destroy an existing one — stop.

Two traps this gate deliberately avoids: grepping `onConflict: "user_id"` would flag the `user_settings` upsert forever (that table's `user_id` genuinely is its primary key, one row per account), and grepping the word `upsert` unanchored would match the comment in `lib/brand-profile.ts` that explains why the old upsert was wrong.

```bash
grep -rn 'from("brand_profiles")' lib app --include="*.ts" --include="*.tsx" | grep -v 'eq("id"' | grep -v "lib/brands.ts" | grep -v "lib/brand-profile.ts"
```
Expected: only `app/(app)/schedule/page.tsx` (which reads the whole account's brands deliberately). Any other match is an account-scoped read that will return an arbitrary row once a second brand exists — fix it before proceeding.

```bash
npx tsc --noEmit && npx vitest run && npm run build
```
Expected: all PASS.

- [ ] **Step 2: Add the control**

In `app/(app)/config/page.tsx`, in the brand band header next to the brand name:

```tsx
<Link href="/onboarding?new=1" className="text-sm text-primary underline-offset-4 hover:underline">
  Add brand
</Link>
```

- [ ] **Step 3: Handle the new-brand flow in onboarding**

`BrandSection` currently hard-imports `saveBrandProfile` (`app/(app)/config/brand-section.tsx:8`) and drives it with `useActionState`. `createBrandAction` has the identical signature — `(prev, formData) => Promise<{ error?: string; ok?: boolean }>` — so make the action injectable rather than branching on a mode flag.

In `app/(app)/config/brand-section.tsx`, add an optional prop and use it in the `useActionState` call:

```tsx
type BrandFormAction = (
  prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
) => Promise<{ error?: string; ok?: boolean }>;

export function BrandSection({
  brand,
  onSaved,
  action = saveBrandProfile,
}: {
  brand: BrandProfile | null;
  onSaved?: () => void;
  action?: BrandFormAction;
}) {
```

then replace `saveBrandProfile` in this component's existing `useActionState(...)` call with `action`. Every current caller keeps working untouched, because the default is the action they already got.

In `app/(app)/onboarding/onboarding-steps.tsx`, thread it through:

```tsx
export function OnboardingSteps({
  brand,
  brandDone,
  categoryDone,
  ideasDone,
  firstCategoryKey,
  creatingBrand = false,
}: {
  brand: BrandProfile | null;
  brandDone: boolean;
  categoryDone: boolean;
  ideasDone: boolean;
  firstCategoryKey: string | null;
  creatingBrand?: boolean;
}) {
```

and where it renders `<BrandSection brand={brand} … />`, pass:

```tsx
<BrandSection
  brand={creatingBrand ? null : brand}
  action={creatingBrand ? createBrandAction : saveBrandProfile}
  onSaved={/* whatever it already passes */}
/>
```

importing both actions from `../config/actions`.

In `app/(app)/onboarding/page.tsx`, read the search param. Per Next 16, `searchParams` is a promise:

```tsx
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: isNew } = await searchParams;
  const creatingBrand = isNew === "1";
```

When `creatingBrand`, the three-step checklist must not report the *active* brand's progress as this new brand's, so force the flags:

```tsx
  const brandDone = creatingBrand ? false : Boolean(brand?.business_name?.trim());
  const categoryDone = creatingBrand ? false : categories.length > 0;
  const ideasDone = creatingBrand ? false : (ideaCount ?? 0) > 0;
```

and pass `creatingBrand` to `OnboardingSteps`.

- [ ] **Step 4: Verify end to end**

With `npm run dev`:
1. Add a second brand from Config. Confirm the first brand's profile is **unchanged** — this is the landmine check, do it explicitly.
2. Confirm the sidebar switcher now appears and switches.
3. Create a category under the second brand; confirm it appears only under that brand in Config, Ideas, and Gallery.
4. Confirm `/schedule` shows both brands.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config/page.tsx" "app/(app)/onboarding/page.tsx"
git commit -m "feat: accounts can add a second brand"
```
