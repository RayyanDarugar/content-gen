# Suggested Post Types + Format Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user ask the system to propose a post type grounded in their brand, and have the format behind every accepted suggestion accumulate into a library that fills itself.

**Architecture:** A new `formats` table holds reusable post structures. `POST /api/categories/suggest` renders the visible library into a prompt alongside the existing `brandBlock`, returns a proposal in the wizard's existing `DraftTurnOutput` shape, and logs the impression. The wizard seeds that proposal as its opening turns and every existing mechanism takes over unchanged. When the model invents a structure rather than drawing on the library, first-persist writes it back as a private format row.

**Tech Stack:** Next.js (App Router, server actions), Supabase (Postgres + RLS), `@anthropic-ai/sdk` with `zodOutputFormat` structured output, Zod, Vitest, Tailwind + shadcn-style UI primitives.

**Spec:** `docs/superpowers/specs/2026-07-29-suggested-post-types-design.md`

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing Next.js code.** This is not the Next.js in your training data — APIs, conventions, and file structure differ. See `AGENTS.md`.
- **The empty library is a fully supported default, never a degraded mode.** With zero visible formats the suggestion flow must work exactly as it does with a library, and must never prompt the user to go seed anything.
- **`formatsBlock([])` returns the empty string exactly** (`toBe("")`), and the prompt builder omits the whole library section when it does. This is the spec's §4 empty-library invariant.
- **Currency claims stay forbidden in every prompt path.** No "trending right now", no invented platform statistics, no named accounts the model cannot verify. The single relaxation: a suggestion built on an `observed` format may name that entry's `source_example`.
- **`shared` is never settable through the app.** Both write policies require the resulting row to have `shared = false`.
- **Never send a messages array whose first element is an `assistant` turn.** The Anthropic API requires the first message to use the `user` role; the local SDK typings do not encode this. Seeded suggestions therefore always begin with a synthetic user turn.
- **All model output is structured output** via `zodOutputFormat`, matching every other LLM surface here. No free-text parsing.
- **BYOK:** every LLM route resolves its key with `requireAnthropicKey(user.id)` and constructs its client with `createAnthropicClient({ apiKey, feature })`.
- **LLM failures surface through `friendlyLlmError(e)`**, with raw detail going to `console.error`.
- **`export const maxDuration = 120`** on every new LLM route.
- **No live-LLM tests.** Test pure functions directly. Run the suite with `npm test`.
- **The model constant** is `process.env.CLAUDE_MODEL || "claude-sonnet-5"`, matching the existing draft route.

---

# Phase 1 — Suggestions, self-filling

Ships complete value on its own. The library starts empty, the invent path carries every suggestion, and the library begins accumulating from the first suggestion anyone keeps.

---

### Task 1: Schema, types, and an RLS verification script

**Files:**
- Create: `supabase/migrations/0017_format_library.sql`
- Modify: `lib/types.ts`
- Create: `scripts/verify-formats-rls.ts`
- Modify: `package.json:11-13` (scripts block)

**Interfaces:**
- Consumes: nothing — this is the foundation task.
- Produces: tables `formats` and `format_suggestions`; column `categories.source_format_id`; TypeScript types `Format`, `FormatOrigin`, `InventedFormat`, `FormatSuggestion`; `Category.source_format_id: string | null`; npm script `verify-formats-rls`.

**Context you need:** `formats` is the first table in this schema whose read policy is deliberately *not* pure owner-isolation — a `shared` row is readable by every tenant. Everything else follows the `owner all` pattern from `supabase/migrations/0005_multi_tenant_foundation.sql`. The `set_updated_at()` trigger function already exists from `0001_init.sql`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0017_format_library.sql`:

```sql
-- supabase/migrations/0017_format_library.sql
-- Suggested post types, spec §3. A "format" is a post structure worth
-- reusing: how the slides are shaped, why that shape works, where it came
-- from, and what kind of brand can carry it.
--
-- This is project 2's Format object arriving early. It lands ahead of the
-- full Brand/Format/Series split deliberately: the suggestion lane needs a
-- place for structures to accumulate, and retrofitting provenance onto
-- categories later is more expensive than adding one nullable column now.

create table formats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  structure text not null,
  why_it_works text not null default '',
  source_example text not null default '',
  brand_fit text not null default '',
  screenshot_url text not null default '',
  -- 'observed' = a real post a human saw work, captured through the
  -- authoring surface; carries a human vouch. 'invented' = model-derived,
  -- promoted because a suggestion stuck. A future scraper adds 'scraped',
  -- which will be the only origin ever carrying verified metrics.
  origin text not null check (origin in ('observed', 'invented')),
  shared boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index formats_user_idx on formats(user_id);
-- The suggestion route's only read: every visible, usable row.
create index formats_visible_idx on formats(shared, active);

create trigger formats_updated_at before update on formats
  for each row execute function set_updated_at();

alter table formats enable row level security;

-- Read is deliberately NOT pure owner-isolation. This is the first such
-- table in the schema, which is why it gets its own verification script.
create policy "read shared or own" on formats for select to authenticated
  using (shared or auth.uid() = user_id);

-- shared is never settable through the app: both write policies require the
-- resulting row to have shared = false. Promoting a format into the shared
-- library is a manual UPDATE in Supabase, and that manual step IS the
-- curation gate.
--
-- Deliberate consequence: a row that is already shared cannot be updated by
-- anyone through the app, including its author, because the with-check would
-- fail. Editing a shared format is a SQL edit. The shared set is small and
-- curated, so this is accepted rather than worked around.
create policy "insert own unshared" on formats for insert to authenticated
  with check (auth.uid() = user_id and shared = false);
create policy "update own unshared" on formats for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and shared = false);
create policy "delete own" on formats for delete to authenticated
  using (auth.uid() = user_id);

-- Provenance ONLY. The approved translation lives verbatim in the category's
-- own columns; re-deriving a category from its format on every run would
-- silently change behavior when the format is edited. on delete set null so
-- retiring a format never destroys a user's post type.
alter table categories
  add column source_format_id uuid references formats(id) on delete set null;

-- Append-only log of what was proposed, written at suggest time — before the
-- user engages — because impressions are the point. Without them, a format
-- shown 100 times and converting 5 is indistinguishable from one shown 5
-- times and converting 5.
create table format_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- null means the model invented the structure rather than drawing on the
  -- library; invented_format then holds what it conceived.
  format_id uuid references formats(id) on delete set null,
  concept text not null default '',
  invented_format jsonb,
  -- Stamped on first persist. Still null = the suggestion was never kept.
  category_id uuid references categories(id) on delete set null,
  created_at timestamptz not null default now()
);

create index format_suggestions_user_idx on format_suggestions(user_id);
create index format_suggestions_format_idx on format_suggestions(format_id);

alter table format_suggestions enable row level security;
create policy "owner all" on format_suggestions for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

- [ ] **Step 2: Add the types**

In `lib/types.ts`, add after the `RoleRefUrls` type:

```ts
export type FormatOrigin = "observed" | "invented";

// A reusable post structure. Landing early from project 2's object model:
// the suggestion lane reads it, and a future scraper writes into it.
export interface Format {
  id: string;
  user_id: string;
  name: string;
  structure: string;
  why_it_works: string;
  source_example: string;
  brand_fit: string;
  screenshot_url: string;
  origin: FormatOrigin;
  shared: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// What the model conceived when it invented a structure instead of drawing
// on the library. Stored on the suggestion row at suggest time so writeback
// keeps what it actually conceived, rather than reconstructing a lossy
// version from the category's columns after the fact.
export interface InventedFormat {
  name: string;
  structure: string;
  why_it_works: string;
  brand_fit: string;
}

export interface FormatSuggestion {
  id: string;
  user_id: string;
  format_id: string | null;
  concept: string;
  invented_format: InventedFormat | null;
  category_id: string | null;
  created_at: string;
}
```

Then add one field to the existing `Category` interface, after `aspect_ratio`:

```ts
  source_format_id: string | null;
```

- [ ] **Step 3: Write the RLS verification script**

Create `scripts/verify-formats-rls.ts`, following the established shape of `scripts/verify-isolation.ts`:

```ts
// scripts/verify-formats-rls.ts
// Verifies the formats RLS policies from migration 0017. Unlike every other
// table here, formats is NOT pure owner-isolation: a shared row is readable
// by every tenant. Run against dev Supabase after 0017 is applied.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const PASSWORD = "test-password-123";

async function makeUser(email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error && !error.message.includes("already been registered")) throw error;
  const id = data?.user?.id ?? (await admin.auth.admin.listUsers()).data.users
    .find((u) => u.email === email)!.id;
  return { id, email };
}

async function sessionClient(email: string) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return c;
}

// Seeds via service role, which bypasses RLS — that is the point: we need a
// shared row to exist, and no app-level client is allowed to create one.
async function seedFormat(userId: string, name: string, shared: boolean) {
  const { data, error } = await admin.from("formats").insert({
    user_id: userId, name, structure: "s", origin: "observed", shared,
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

const failures: string[] = [];
function check(label: string, pass: boolean) {
  console.log(pass ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!pass) failures.push(label);
}

async function main() {
  const a = await makeUser("fmt-a@example.com");
  const b = await makeUser("fmt-b@example.com");
  await admin.from("formats").delete().in("user_id", [a.id, b.id]);

  const aPrivate = await seedFormat(a.id, "a-private", false);
  const aShared = await seedFormat(a.id, "a-shared", true);
  const bPrivate = await seedFormat(b.id, "b-private", false);

  const ca = await sessionClient(a.email);
  const cb = await sessionClient(b.email);

  const { data: bSees } = await cb.from("formats").select("id");
  const bIds = new Set((bSees ?? []).map((r) => r.id as string));

  check("1. B cannot read A's unshared format", !bIds.has(aPrivate));
  check("2. B CAN read A's shared format", bIds.has(aShared));
  check("2b. B can still read its own format", bIds.has(bPrivate));

  const ins = await cb.from("formats").insert({
    user_id: b.id, name: "sneaky", structure: "s", origin: "observed", shared: true,
  });
  check("3. A tenant cannot insert shared = true", ins.error !== null);

  const upd = await cb.from("formats").update({ shared: true }).eq("id", bPrivate).select("id");
  check("4. A tenant cannot update a row to shared = true",
    upd.error !== null || (upd.data ?? []).length === 0);

  const updShared = await ca.from("formats")
    .update({ name: "renamed" }).eq("id", aShared).select("id");
  check("5. Nobody can update an already-shared row through the app",
    updShared.error !== null || (updShared.data ?? []).length === 0);

  const { data: bLogs } = await cb.from("format_suggestions").select("id");
  const { error: logInsErr } = await admin.from("format_suggestions")
    .insert({ user_id: a.id, concept: "a-log" });
  if (logInsErr) throw logInsErr;
  const { data: bLogsAfter } = await cb.from("format_suggestions").select("id");
  check("6. B cannot read A's format_suggestions",
    (bLogsAfter ?? []).length === (bLogs ?? []).length);

  await admin.from("format_suggestions").delete().in("user_id", [a.id, b.id]);
  await admin.from("formats").delete().in("user_id", [a.id, b.id]);

  if (failures.length) throw new Error(`FORMATS RLS FAILED:\n- ${failures.join("\n- ")}`);
  console.log("FORMATS RLS OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Note on checks 4 and 5: PostgREST does not error when a `using` clause filters a row out of an UPDATE — it matches zero rows and returns an empty array. Both outcomes are accepted as a pass, which is why each asserts `error !== null || data.length === 0`.

- [ ] **Step 4: Register the npm script**

In `package.json`, add to the `scripts` block beside `verify-isolation`:

```json
    "verify-formats-rls": "tsx scripts/verify-formats-rls.ts",
```

- [ ] **Step 5: Verify the project still builds and the suite is green**

Run: `npm test && npx tsc --noEmit`
Expected: all existing tests pass; no type errors. `Category.source_format_id` is a new required field, so any object literal constructing a full `Category` in test fixtures will now fail to typecheck — fix those by adding `source_format_id: null`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0017_format_library.sql lib/types.ts scripts/verify-formats-rls.ts package.json
git commit -m "feat: format library schema, types, and RLS verification script"
```

> **Hand-off to Rayyan:** migration 0017 must be applied to Supabase by hand before Task 4's route can run, then `npm run verify-formats-rls` must pass. Flag this at task review rather than assuming it is done.

---

### Task 2: `formatsBlock` — render the library as a prompt menu

**Files:**
- Create: `lib/athena/formats.ts`
- Create: `tests/formats.test.ts`

**Interfaces:**
- Consumes: `Format` from `@/lib/types` (Task 1).
- Produces: `formatsBlock(formats: Format[], excludeFormatIds?: string[]): string` — the library rendered for the suggestion prompt, or `""` when nothing is usable.

**Context you need:** This is a pure function with no I/O, tested directly like `brandBlock` in `lib/athena/prompts.ts`. The empty-string return is load-bearing: the caller omits the entire library section when it is empty, which is what makes the empty-library prompt identical to a no-library prompt.

- [ ] **Step 1: Write the failing tests**

Create `tests/formats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatsBlock } from "@/lib/athena/formats";
import type { Format } from "@/lib/types";

function fmt(over: Partial<Format> = {}): Format {
  return {
    id: "f1", user_id: "u1", name: "Myth bust",
    structure: "Hook states the myth, two beats dismantle it, payoff gives the real insight.",
    why_it_works: "A myth opens a curiosity gap the payoff closes.",
    source_example: "Seen on a study-skills account",
    brand_fit: "Brands with a teaching voice and real domain authority.",
    screenshot_url: "", origin: "observed", shared: true, active: true,
    created_at: "", updated_at: "", ...over,
  };
}

describe("formatsBlock", () => {
  it("returns exactly the empty string when there are no formats", () => {
    expect(formatsBlock([])).toBe("");
  });

  it("returns exactly the empty string when every format is excluded", () => {
    expect(formatsBlock([fmt({ id: "f1" })], ["f1"])).toBe("");
  });

  it("renders every field a suggestion needs, including the id", () => {
    const out = formatsBlock([fmt()]);
    expect(out).toContain("id: f1");
    expect(out).toContain("Myth bust");
    expect(out).toContain("two beats dismantle it");
    expect(out).toContain("curiosity gap");
    expect(out).toContain("Seen on a study-skills account");
    expect(out).toContain("teaching voice");
  });

  it("puts observed formats before invented ones", () => {
    const out = formatsBlock([
      fmt({ id: "inv", name: "Invented one", origin: "invented" }),
      fmt({ id: "obs", name: "Observed one", origin: "observed" }),
    ]);
    expect(out.indexOf("Observed one")).toBeLessThan(out.indexOf("Invented one"));
  });

  it("labels each entry with its origin so the model can weigh the evidence", () => {
    const out = formatsBlock([fmt({ id: "inv", origin: "invented" })]);
    expect(out).toContain("[invented]");
  });

  it("drops only the excluded ids and keeps the rest", () => {
    const out = formatsBlock([fmt({ id: "a", name: "Alpha" }), fmt({ id: "b", name: "Beta" })], ["a"]);
    expect(out).not.toContain("Alpha");
    expect(out).toContain("Beta");
  });

  it("omits an empty optional field rather than printing a blank label", () => {
    const out = formatsBlock([fmt({ source_example: "", brand_fit: "" })]);
    expect(out).not.toContain("Source example:");
    expect(out).not.toContain("Fits brands that:");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/formats.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/formats`.

- [ ] **Step 3: Implement `formatsBlock`**

Create `lib/athena/formats.ts`:

```ts
import type { Format } from "@/lib/types";

// The library rendered as a menu for the suggestion prompt.
//
// Empty in, empty string out — EXACTLY. The caller omits the whole library
// section when this is empty, which is what makes a zero-format prompt
// identical to a no-library prompt (spec §4). A header with nothing under it
// would both waste tokens and imply to the model that a library exists but
// had nothing worth showing.
export function formatsBlock(formats: Format[], excludeFormatIds: string[] = []): string {
  const excluded = new Set(excludeFormatIds);
  const usable = formats.filter((f) => !excluded.has(f.id));
  if (!usable.length) return "";

  // 'observed' carries a human vouch; 'invented' is only ever a suggestion
  // that happened to stick. A handful of real seeds should outrank a pile of
  // model-derived rows, which is the whole reason origin exists as a column.
  // Array.prototype.sort is stable, so ties keep their incoming order.
  const ranked = [...usable].sort(
    (a, b) => originRank(a.origin) - originRank(b.origin),
  );

  const lines = [
    "FORMAT LIBRARY — post structures already known to work.",
    "Prefer an entry here when one genuinely fits this brand. Invent a new structure only when none does; inventing is a perfectly good outcome, not a failure.",
    "[observed] entries were captured from a real post a human saw work. [invented] entries were generated by this system and kept by a user — weaker evidence, so prefer an observed entry when both fit.",
    "",
  ];
  for (const f of ranked) {
    lines.push(`- id: ${f.id} [${f.origin}]`);
    lines.push(`  Name: ${f.name}`);
    lines.push(`  Structure: ${f.structure}`);
    if (f.why_it_works.trim()) lines.push(`  Why it works: ${f.why_it_works.trim()}`);
    if (f.source_example.trim()) lines.push(`  Source example: ${f.source_example.trim()}`);
    if (f.brand_fit.trim()) lines.push(`  Fits brands that: ${f.brand_fit.trim()}`);
  }
  return lines.join("\n");
}

function originRank(origin: Format["origin"]): number {
  return origin === "observed" ? 0 : 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/formats.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/formats.ts tests/formats.test.ts
git commit -m "feat: render the format library as a suggestion prompt menu"
```

---

### Task 3: The suggestion prompt, output schema, and seeding logic

**Files:**
- Create: `lib/athena/suggest-category.ts`
- Create: `tests/suggest-category.test.ts`

**Interfaces:**
- Consumes: `formatsBlock` (Task 2); `brandBlock`, `BrandContext` from `@/lib/athena/prompts`; `DraftTurnOutput`, `normalizeDraft`, `DraftTurn`, `NormalizedDraft` from `@/lib/athena/draft-category`; `validateSlideShape`, `ShapeResult` from `@/lib/athena/slides`; `Format`, `InventedFormat`, `Slide` from `@/lib/types`.
- Produces:
  - `SuggestOutput` — the Zod schema for the model's structured output.
  - `SuggestedSample` — `{ concept: string; slides: Slide[]; caption: string }`.
  - `SuggestResponse` — `{ suggestionId: string; formatId: string | null; rationale: string; draft: NormalizedDraft; sample: SuggestedSample }`, the route's JSON response.
  - `buildSuggestSystemPrompt(brand: BrandContext, formats: Format[], excludeFormatIds: string[], excludeConcepts: string[]): string`
  - `validateSuggestedSample(sample: SuggestedSample, draft: NormalizedDraft): ShapeResult`
  - `suggestionToTurns(res: SuggestResponse): DraftTurn[]`

**Context you need — read this before writing code:**

1. **`suggestionToTurns` returns TWO turns, and the first is a `user` turn.** The Anthropic API requires a messages array to begin with the `user` role, and the wizard sends its whole turn history to `/api/categories/draft` on the next message. Seeding an assistant turn alone would make the *next* turn fail with a 400, long after the suggestion appeared to work. The synthetic user turn ("Suggest a post type for my brand.") is also simply what happened, so it reads correctly in the chat.

2. **`draft` reuses `DraftTurnOutput` verbatim** by nesting the existing schema. Do not redefine those fields — the whole point is that the result drops into the wizard's live panel with zero adaptation.

3. **The sample's expected slide count depends on `post_type`.** An `independent` post type's sample is ONE standalone image (role `single`); a `narrative` one has `images_per_carousel` slides (hook / beats / payoff). `validateSlideShape` already encodes both rules.

- [ ] **Step 1: Write the failing tests**

Create `tests/suggest-category.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildSuggestSystemPrompt, validateSuggestedSample, suggestionToTurns,
  type SuggestResponse,
} from "@/lib/athena/suggest-category";
import { formatsBlock } from "@/lib/athena/formats";
import type { BrandContext } from "@/lib/athena/prompts";
import type { Format } from "@/lib/types";
import type { NormalizedDraft as ND } from "@/lib/athena/draft-category";

const brand: BrandContext = {
  business_name: "Athena",
  business_description: "An SAT prep platform that teaches like a personal tutor.",
  audience: "Parents of high-schoolers",
  voice: "Warm, encouraging, plain-spoken",
  avoid: "AI-powered, dashboards, analytics",
  proof_points: ["Median score lift of 140 points across 3,000 students"],
  standing: ["test preparation", "high-school academics"],
  colors: [], fonts: [], visual_notes: "",
};

function fmt(over: Partial<Format> = {}): Format {
  return {
    id: "f1", user_id: "u1", name: "Myth bust",
    structure: "Hook states the myth, two beats dismantle it, payoff gives the real insight.",
    why_it_works: "A myth opens a curiosity gap the payoff closes.",
    source_example: "Seen on a study-skills account",
    brand_fit: "Brands with a teaching voice.",
    screenshot_url: "", origin: "observed", shared: true, active: true,
    created_at: "", updated_at: "", ...over,
  };
}

const draft: ND = {
  name: "Myth bust", style_guide: "Flat illustration, bold headline.",
  output_format: "myth, two dismantling beats, real insight",
  post_type: "narrative", role_guides: {}, caption_guide: "",
  images_per_carousel: 4, aspect_ratio: "4:5",
};

describe("buildSuggestSystemPrompt", () => {
  it("grounds the suggestion in the brand's material", () => {
    const out = buildSuggestSystemPrompt(brand, [], [], []);
    expect(out).toContain("Median score lift of 140 points");
    expect(out).toContain("test preparation");
  });

  it("forbids currency claims even when the library is empty", () => {
    const out = buildSuggestSystemPrompt(brand, [], [], []);
    expect(out.toLowerCase()).toContain("do not claim");
    expect(out).toContain("trending");
  });

  it("forbids currency claims when the library IS present", () => {
    const out = buildSuggestSystemPrompt(brand, [fmt()], [], []);
    expect(out).toContain("trending");
  });

  it("omits the library section entirely when there are no formats", () => {
    const out = buildSuggestSystemPrompt(brand, [], [], []);
    expect(out).not.toContain("FORMAT LIBRARY");
  });

  // The empty-library invariant, spec §4: a library adds a block and changes
  // NOTHING else. Expressed as a difference rather than a brittle full-string
  // snapshot, so it stays meaningful as the prompt's wording evolves.
  it("adds only the library block and leaves the rest of the prompt untouched", () => {
    const bare = buildSuggestSystemPrompt(brand, [], [], []);
    const withLib = buildSuggestSystemPrompt(brand, [fmt()], [], []);
    const block = formatsBlock([fmt()]);
    expect(withLib).toContain(block);
    expect(withLib.replace(block, "").replace(/\n{2,}/g, "\n\n").trim())
      .toBe(bare.replace(/\n{2,}/g, "\n\n").trim());
  });

  it("renders excluded concepts when supplied and omits the section when empty", () => {
    expect(buildSuggestSystemPrompt(brand, [], [], ["a myth-bust carousel"]))
      .toContain("a myth-bust carousel");
    expect(buildSuggestSystemPrompt(brand, [], [], [])).not.toContain("ALREADY SHOWN");
  });

  it("passes excluded format ids through to the library block", () => {
    const out = buildSuggestSystemPrompt(brand, [fmt({ id: "f1" })], ["f1"], []);
    expect(out).not.toContain("FORMAT LIBRARY");
  });

  it("asserts no palette when the brand has none", () => {
    const out = buildSuggestSystemPrompt(brand, [], [], []);
    expect(out).not.toContain("Palette:");
  });

  it("uses the brand's real palette when it has one", () => {
    const out = buildSuggestSystemPrompt({ ...brand, colors: ["#123456"] }, [], [], []);
    expect(out).toContain("#123456");
  });
});

describe("validateSuggestedSample", () => {
  it("accepts a well-formed narrative sample", () => {
    const sample = {
      concept: "Three SAT myths", caption: "",
      slides: [
        { role: "hook" as const, text: "MYTH", visual: "a" },
        { role: "beat" as const, text: "b", visual: "b" },
        { role: "beat" as const, text: "c", visual: "c" },
        { role: "payoff" as const, text: "d", visual: "d" },
      ],
    };
    expect(validateSuggestedSample(sample, draft).ok).toBe(true);
  });

  it("rejects a narrative sample with the wrong slide count", () => {
    const sample = {
      concept: "x", caption: "",
      slides: [
        { role: "hook" as const, text: "a", visual: "a" },
        { role: "payoff" as const, text: "b", visual: "b" },
      ],
    };
    expect(validateSuggestedSample(sample, draft).ok).toBe(false);
  });

  // An independent post type's sample is ONE standalone image, regardless of
  // images_per_carousel — that field means "how many per batch" there.
  it("expects exactly one 'single' slide for an independent post type", () => {
    const indep: ND = { ...draft, post_type: "independent", images_per_carousel: 5 };
    const ok = { concept: "x", caption: "", slides: [{ role: "single" as const, text: "a", visual: "a" }] };
    const bad = { concept: "x", caption: "", slides: [{ role: "hook" as const, text: "a", visual: "a" }] };
    expect(validateSuggestedSample(ok, indep).ok).toBe(true);
    expect(validateSuggestedSample(bad, indep).ok).toBe(false);
  });
});

describe("suggestionToTurns", () => {
  const res: SuggestResponse = {
    suggestionId: "s1", formatId: "f1",
    rationale: "A myth opens a curiosity gap. It fits Athena's 140-point lift.",
    draft,
    sample: {
      concept: "Three SAT myths", caption: "Here's what actually moves the needle.",
      slides: [
        { role: "hook", text: "MYTH: cramming works", visual: "a" },
        { role: "beat", text: "b", visual: "b" },
        { role: "beat", text: "c", visual: "c" },
        { role: "payoff", text: "Spaced practice wins", visual: "d" },
      ],
    },
  };

  // Load-bearing: the Anthropic API rejects a messages array that starts with
  // an assistant turn, and the wizard replays its whole history on the next
  // message. An assistant-first seed would fail on turn 2, not turn 1.
  it("starts with a user turn so the replayed history stays valid", () => {
    const turns = suggestionToTurns(res);
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");
    expect(turns).toHaveLength(2);
  });

  it("carries the draft on the assistant turn so the live panel fills in", () => {
    expect(suggestionToTurns(res)[1].draft).toEqual(draft);
  });

  it("shows the rationale and the worked sample in the assistant turn's text", () => {
    const text = suggestionToTurns(res)[1].text;
    expect(text).toContain("curiosity gap");
    expect(text).toContain("MYTH: cramming works");
    expect(text).toContain("Spaced practice wins");
    expect(text).toContain("Here's what actually moves the needle.");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/suggest-category.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/suggest-category`.

- [ ] **Step 3: Implement the module**

Create `lib/athena/suggest-category.ts`:

```ts
import { z } from "zod";
import { brandBlock, type BrandContext } from "@/lib/athena/prompts";
import { formatsBlock } from "@/lib/athena/formats";
import { validateSlideShape, type ShapeResult } from "@/lib/athena/slides";
import { DraftTurnOutput, type DraftTurn, type NormalizedDraft } from "@/lib/athena/draft-category";
import type { Format, Slide } from "@/lib/types";

// The model returns the whole proposal in one structured call: which format
// it used (or invented), why, a fully-worked sample post, and the post-type
// config itself. draft nests the wizard's existing schema verbatim so the
// result drops into the live panel with zero adaptation.
export const SuggestOutput = z.object({
  format_id: z.string().describe(
    "The exact id of the FORMAT LIBRARY entry this is built on. Empty string if you invented the structure yourself.",
  ),
  invented_format: z.object({
    name: z.string(),
    structure: z.string().describe("The reusable shape, independent of this brand"),
    why_it_works: z.string().describe("Why the structure works mechanically"),
    brand_fit: z.string().describe("What kind of brand can carry it"),
  }).describe(
    "The structure you invented, written so it could be reused by a different brand. Use empty strings for every field when format_id names a library entry.",
  ),
  rationale: z.string().describe(
    "Exactly two sentences. First: why this structure works mechanically. Second: why it fits THIS brand, naming a real proof point or standing entry.",
  ),
  sample: z.object({
    concept: z.string().describe("One-line summary of the sample post"),
    slides: z.array(z.object({
      role: z.enum(["hook", "beat", "payoff", "single"]),
      text: z.string().describe("The words that appear on the panel"),
      visual: z.string().describe("Scene, camera angle, subject pose"),
    })),
    caption: z.string().describe("The published caption for the sample post"),
  }),
  draft: DraftTurnOutput,
});

export interface SuggestedSample {
  concept: string;
  slides: Slide[];
  caption: string;
}

export interface SuggestResponse {
  suggestionId: string;
  formatId: string | null;
  rationale: string;
  draft: NormalizedDraft;
  sample: SuggestedSample;
}

export function buildSuggestSystemPrompt(
  brand: BrandContext,
  formats: Format[],
  excludeFormatIds: string[],
  excludeConcepts: string[],
): string {
  const lines = [
    "You are proposing a POST TYPE (a \"category\") for the owner of this business: a reusable recipe their content engine uses to write and illustrate social posts.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    "Return ONE proposal: the post-type config, a fully-worked sample post using this brand's real material, and a two-sentence rationale.",
    "",
    "HONESTY RULES — these are absolute:",
    "- Do not claim anything is currently popular, trending, or working right now. Your knowledge has a cutoff and you cannot verify what is current.",
    "- Do not invent platform statistics, engagement numbers, or follower counts.",
    "- Do not name real accounts or creators as examples unless a FORMAT LIBRARY entry below names one, in which case you may cite that entry's source example and nothing more.",
    "- The rationale must be CRAFT plus FIT. Craft: why the structure works mechanically. Fit: why it suits THIS brand, naming a real proof point or standing entry from the brand context above.",
    "- The sample must use this brand's actual material. A sample built on invented claims is worse than no sample — it proves the system does not know them.",
  ];

  const library = formatsBlock(formats, excludeFormatIds);
  if (library) {
    lines.push("", library, "",
      "Set format_id to the id of the entry you used, and leave every invented_format field an empty string.",
      "If no entry genuinely fits this brand, invent a structure instead: leave format_id an empty string and fill in invented_format so the structure could be reused by a different brand later.",
    );
  } else {
    lines.push("", "Invent a structure from your own knowledge of what makes social posts work.",
      "Fill in invented_format so the structure could be reused by a different brand later, and leave format_id an empty string.",
    );
  }

  if (excludeConcepts.length) {
    lines.push("", "ALREADY SHOWN this session — propose something genuinely different, not a rephrasing:",
      ...excludeConcepts.map((c) => `- ${c}`));
  }

  lines.push("", "FIELD RULES for draft:",
    "- style_guide holds what EVERY panel shares: palette, subject or character, typography, layout, any persistent footer. Write it as direct instructions to an image model. Use the brand's own visual identity above as the default look.",
    "- post_type is 'independent' when each image stands completely alone, 'narrative' when the slides tell ONE story (hook, beats, payoff).",
    "- role_guides holds ONLY treatment belonging to a single role. Anything named there must NOT also appear in style_guide.",
    "- caption_guide: how the published TEXT is written. Empty string when static rotating captions fit better.",
    "- images_per_carousel: for narrative, the slide count of the story (2-10). For independent, how many standalone images one batch produces.",
    "",
    "The sample's slides must match draft.post_type: an independent post type gets EXACTLY ONE slide with role 'single'; a narrative one gets exactly images_per_carousel slides, opening with 'hook', closing with 'payoff', all middle slides 'beat'.",
  );

  return lines.join("\n");
}

export function validateSuggestedSample(
  sample: SuggestedSample,
  draft: NormalizedDraft,
): ShapeResult {
  // An independent post type's sample is one standalone image; there,
  // images_per_carousel means "how many per batch", not "slides in a story".
  const expected = draft.post_type === "independent" ? 1 : draft.images_per_carousel;
  return validateSlideShape(sample.slides, expected);
}

// Seeds the wizard conversation. Returns TWO turns, and the first is a user
// turn — the Anthropic API rejects a messages array beginning with an
// assistant turn, and the wizard replays this whole history on the next
// message, so an assistant-only seed would fail on turn 2 rather than turn 1.
// It is also just what happened: the user asked for a suggestion.
export function suggestionToTurns(res: SuggestResponse): DraftTurn[] {
  return [
    { role: "user", text: "Suggest a post type for my brand." },
    { role: "assistant", text: renderSuggestion(res), draft: res.draft },
  ];
}

function renderSuggestion(res: SuggestResponse): string {
  const { sample } = res;
  const slides = sample.slides.map(
    (s, i) => `${i + 1}. [${s.role}] ${s.text}${s.visual.trim() ? `\n   Visual: ${s.visual.trim()}` : ""}`,
  );
  return [
    res.rationale,
    "",
    `Here's how it would look — "${sample.concept}":`,
    ...slides,
    ...(sample.caption.trim() ? ["", `Caption: ${sample.caption.trim()}`] : []),
    "",
    "Want to change anything, or should we test it with real images?",
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/suggest-category.test.ts`
Expected: PASS, all tests.

If the "adds only the library block" test fails on whitespace, fix the *implementation* to append the block cleanly rather than loosening the test — that invariant is the point of the task.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/athena/suggest-category.ts tests/suggest-category.test.ts
git commit -m "feat: suggestion prompt, output schema, and wizard seeding logic"
```

---

### Task 4: `POST /api/categories/suggest`

**Files:**
- Create: `app/api/categories/suggest/route.ts`

**Interfaces:**
- Consumes: `buildSuggestSystemPrompt`, `SuggestOutput`, `validateSuggestedSample`, `SuggestResponse` (Task 3); `normalizeDraft` from `@/lib/athena/draft-category`; `Format`, `BrandContext`; `requireUser`, `requireAnthropicKey`, `createAnthropicClient`, `friendlyLlmError`.
- Produces: `POST /api/categories/suggest` returning `SuggestResponse` as JSON.

**Context you need:** Model this route on `app/api/categories/draft/route.ts` — same auth, same brand load, same client construction, same error handling. Two differences: it persists no category, and it writes one `format_suggestions` row.

- [ ] **Step 1: Write the route**

Create `app/api/categories/suggest/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createAnthropicClient } from "@/lib/anthropic";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { normalizeDraft } from "@/lib/athena/draft-category";
import {
  SuggestOutput, buildSuggestSystemPrompt, validateSuggestedSample,
  type SuggestResponse,
} from "@/lib/athena/suggest-category";
import type { BrandContext } from "@/lib/athena/prompts";
import type { Format } from "@/lib/types";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
// A draft object plus a worked sample post — larger than a draft turn, still
// far short of the 16k idea batches.
const SUGGEST_MAX_TOKENS = 6000;

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const excludeConcepts = stringArray(body?.excludeConcepts);
  const excludeFormatIds = stringArray(body?.excludeFormatIds);

  try {
    const supabase = await createServerSupabase();

    const { data: brandRow } = await supabase
      .from("brand_profiles").select("*").eq("user_id", user.id).maybeSingle();
    if (!brandRow?.business_name?.trim()) {
      return NextResponse.json(
        { error: "Add your business name in brand setup first — a suggestion needs something to build on." },
        { status: 400 });
    }
    const brand: BrandContext = {
      business_name: brandRow.business_name ?? "",
      business_description: brandRow.business_description ?? "",
      audience: brandRow.audience ?? "",
      voice: brandRow.voice ?? "",
      avoid: brandRow.avoid ?? "",
      proof_points: brandRow.proof_points ?? [],
      standing: brandRow.standing ?? [],
      colors: brandRow.colors ?? [],
      fonts: brandRow.fonts ?? [],
      visual_notes: brandRow.visual_notes ?? "",
    };

    // RLS already restricts this to shared rows plus the caller's own.
    const { data: formatRows } = await supabase
      .from("formats").select("*").eq("active", true);
    const formats = (formatRows ?? []) as Format[];

    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "category_suggest",
    });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: SUGGEST_MAX_TOKENS,
      system: buildSuggestSystemPrompt(brand, formats, excludeFormatIds, excludeConcepts),
      messages: [{ role: "user", content: "Suggest a post type for my brand." }],
      output_config: { format: zodOutputFormat(SuggestOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error(`suggestion returned no parseable output (stop_reason: ${response.stop_reason})`);
    }

    const { assistant_message: _ignored, ...draftFields } = parsed.draft;
    const draft = normalizeDraft(draftFields);
    const sample = parsed.sample;

    // A malformed sample is a failed suggestion, not something to render
    // half of — the user would be shown a broken example of their own brand.
    const shape = validateSuggestedSample(sample, draft);
    if (!shape.ok) {
      throw new Error(`suggested sample has the wrong shape: ${shape.reason}`);
    }

    // Only trust format_id if it names a format we actually showed the model;
    // a hallucinated id would create a dangling provenance link.
    const claimedId = parsed.format_id.trim();
    const formatId = formats.some((f) => f.id === claimedId) ? claimedId : null;

    const { data: logRow, error: logError } = await supabase
      .from("format_suggestions")
      .insert({
        user_id: user.id,
        format_id: formatId,
        concept: sample.concept,
        // Only meaningful when nothing from the library was used. Stored now
        // so writeback keeps what the model actually conceived.
        invented_format: formatId ? null : parsed.invented_format,
      })
      .select("id")
      .single();
    if (logError) throw new Error(logError.message);

    const payload: SuggestResponse = {
      suggestionId: logRow.id as string,
      formatId,
      rationale: parsed.rationale,
      draft,
      sample,
    };
    return NextResponse.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("suggestion failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify it typechecks and the suite is still green**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/api/categories/suggest/route.ts
git commit -m "feat: POST /api/categories/suggest"
```

---

### Task 5: Writeback — link the format, or save the invented one

**Files:**
- Create: `lib/athena/suggestion-writeback.ts`
- Create: `tests/suggestion-writeback.test.ts`
- Modify: `app/api/categories/draft/route.ts`

**Interfaces:**
- Consumes: `FormatSuggestion`, `InventedFormat` from `@/lib/types`.
- Produces:
  - `writebackPlan(suggestion): WritebackPlan` where `WritebackPlan` is `{ kind: "none" } | { kind: "link"; formatId: string } | { kind: "create"; invented: InventedFormat }`.
  - `inventedFormatRow(userId: string, invented: InventedFormat)` — the insert payload for `formats`.
  - `POST /api/categories/draft` accepts an optional `suggestionId` in its body.

**Context you need:** The decision is pure and testable; the I/O around it is thin. Writeback runs on the **insert path only** — `insertDraft` in the draft route — never on an update, or every subsequent turn would create another format row. Per spec §11, a writeback failure must never fail the persist: the category is the user's work, a missing format row is a lost analytics record.

- [ ] **Step 1: Write the failing tests**

Create `tests/suggestion-writeback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { writebackPlan, inventedFormatRow } from "@/lib/athena/suggestion-writeback";
import type { InventedFormat } from "@/lib/types";

const invented: InventedFormat = {
  name: "Myth bust",
  structure: "Hook states the myth, beats dismantle it, payoff gives the insight.",
  why_it_works: "A curiosity gap the payoff closes.",
  brand_fit: "Brands with a teaching voice.",
};

describe("writebackPlan", () => {
  it("does nothing when there is no suggestion", () => {
    expect(writebackPlan(null)).toEqual({ kind: "none" });
  });

  it("links an existing format when the suggestion drew on the library", () => {
    expect(writebackPlan({ format_id: "f1", invented_format: null }))
      .toEqual({ kind: "link", formatId: "f1" });
  });

  it("creates a format when the model invented the structure", () => {
    expect(writebackPlan({ format_id: null, invented_format: invented }))
      .toEqual({ kind: "create", invented });
  });

  it("does nothing when invented with no usable structure to save", () => {
    expect(writebackPlan({ format_id: null, invented_format: null })).toEqual({ kind: "none" });
    expect(writebackPlan({ format_id: null, invented_format: { ...invented, structure: "  " } }))
      .toEqual({ kind: "none" });
  });

  // A library-drawn suggestion must never also mint a row, or every accepted
  // suggestion would duplicate the format it came from.
  it("prefers linking over creating when both are somehow present", () => {
    expect(writebackPlan({ format_id: "f1", invented_format: invented }))
      .toEqual({ kind: "link", formatId: "f1" });
  });
});

describe("inventedFormatRow", () => {
  it("marks the row invented, private, and owned by the user", () => {
    const row = inventedFormatRow("u1", invented);
    expect(row.user_id).toBe("u1");
    expect(row.origin).toBe("invented");
    expect(row.shared).toBe(false);
    expect(row.active).toBe(true);
  });

  it("carries the model's own words rather than reconstructing them", () => {
    const row = inventedFormatRow("u1", invented);
    expect(row.structure).toBe(invented.structure);
    expect(row.why_it_works).toBe(invented.why_it_works);
    expect(row.brand_fit).toBe(invented.brand_fit);
  });

  it("leaves observed-only fields empty", () => {
    const row = inventedFormatRow("u1", invented);
    expect(row.source_example).toBe("");
    expect(row.screenshot_url).toBe("");
  });

  it("falls back to a placeholder name rather than writing an empty one", () => {
    expect(inventedFormatRow("u1", { ...invented, name: "   " }).name).toBe("Untitled format");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/suggestion-writeback.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/suggestion-writeback`.

- [ ] **Step 3: Implement the module**

Create `lib/athena/suggestion-writeback.ts`:

```ts
import type { FormatSuggestion, InventedFormat } from "@/lib/types";

export type WritebackPlan =
  | { kind: "none" }
  | { kind: "link"; formatId: string }
  | { kind: "create"; invented: InventedFormat };

// What to do when a suggestion is persisted into a real category for the
// first time. Pure, so the interesting decision is testable without a
// database: the route around it is a thin executor.
export function writebackPlan(
  suggestion: Pick<FormatSuggestion, "format_id" | "invented_format"> | null,
): WritebackPlan {
  if (!suggestion) return { kind: "none" };
  // Linking wins over creating. A suggestion that drew on the library must
  // never also mint a row, or every acceptance would duplicate its source.
  if (suggestion.format_id) return { kind: "link", formatId: suggestion.format_id };
  const invented = suggestion.invented_format;
  if (!invented?.structure?.trim()) return { kind: "none" };
  return { kind: "create", invented };
}

// The insert payload for an invented format. shared is false and unsettable
// by policy anyway, but it is written explicitly so the intent is legible at
// the call site: an invented row can only ever pollute its own tenant.
export function inventedFormatRow(userId: string, invented: InventedFormat) {
  return {
    user_id: userId,
    name: invented.name.trim() || "Untitled format",
    structure: invented.structure,
    why_it_works: invented.why_it_works,
    brand_fit: invented.brand_fit,
    source_example: "",
    screenshot_url: "",
    origin: "invented" as const,
    shared: false,
    active: true,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/suggestion-writeback.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire writeback into the draft route**

In `app/api/categories/draft/route.ts`:

Add the imports:

```ts
import { writebackPlan, inventedFormatRow } from "@/lib/athena/suggestion-writeback";
import type { FormatSuggestion } from "@/lib/types";
```

Read `suggestionId` from the body, beside the existing `styleRefUrl` line (around line 65):

```ts
  const suggestionId = typeof body?.suggestionId === "string" && body.suggestionId ? body.suggestionId : null;
```

Replace the existing `insertDraft` call (around line 135) so it carries the suggestion:

```ts
      id = await insertDraft(supabase, user.id, draft, styleRefUrl ?? "");
      // Insert path only. On an update this would mint a duplicate format on
      // every subsequent turn of the same conversation.
      if (suggestionId) await applyWriteback(supabase, user.id, suggestionId, id);
```

Then add this function at the end of the file, after `insertDraft`:

```ts
// Records where a kept suggestion came from, and saves the format itself when
// the model invented one — this is how the library fills without anyone
// curating it.
//
// Never throws. A category that saved correctly is the user's work; a missing
// formats row is a lost analytics record. Failing the request here would
// trade the former for the latter.
async function applyWriteback(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  userId: string,
  suggestionId: string,
  categoryId: string,
): Promise<void> {
  try {
    // RLS scopes this to the caller, so a forged id from another tenant
    // simply finds nothing.
    const { data } = await supabase
      .from("format_suggestions")
      .select("format_id, invented_format")
      .eq("id", suggestionId)
      .maybeSingle();

    const plan = writebackPlan((data as Pick<FormatSuggestion, "format_id" | "invented_format">) ?? null);

    let sourceFormatId: string | null = null;
    if (plan.kind === "link") {
      sourceFormatId = plan.formatId;
    } else if (plan.kind === "create") {
      const { data: created, error } = await supabase
        .from("formats").insert(inventedFormatRow(userId, plan.invented)).select("id").single();
      if (error) throw new Error(error.message);
      sourceFormatId = created.id as string;
    }

    if (sourceFormatId) {
      await supabase.from("categories")
        .update({ source_format_id: sourceFormatId }).eq("id", categoryId);
    }
    await supabase.from("format_suggestions")
      .update({ category_id: categoryId }).eq("id", suggestionId);
  } catch (e) {
    console.error("suggestion writeback failed:", e instanceof Error ? e.message : String(e));
  }
}
```

- [ ] **Step 6: Verify the whole suite and types**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/suggestion-writeback.ts tests/suggestion-writeback.test.ts app/api/categories/draft/route.ts
git commit -m "feat: write suggestion provenance back, saving invented formats"
```

---

### Task 6: Wizard suggest mode

**Files:**
- Modify: `app/(app)/config/draft/page.tsx`
- Modify: `app/(app)/config/draft/draft-wizard.tsx`

**Interfaces:**
- Consumes: `suggestionToTurns`, `SuggestResponse` (Task 3); `POST /api/categories/suggest` (Task 4); the `suggestionId` body field on `POST /api/categories/draft` (Task 5).
- Produces: `/config/draft?suggest=1` — the wizard opens, fetches a suggestion on mount, and seeds the conversation with it.

**Context you need — read `node_modules/next/dist/docs/` before editing these files.** `searchParams` is a Promise in this version and is already awaited in `page.tsx:13`.

Behavior required:
- On mount in suggest mode, call the endpoint and seed `turns` with `suggestionToTurns(res)`.
- Nothing persists until the user sends a real turn. The seeded turns are client state only; `categoryId` stays `null`, so the "Saved automatically" note and the preview pane stay hidden — which is already how they are gated.
- The first real turn sends `suggestionId` so writeback can run.
- "Suggest a different one" re-rolls, accumulating `excludeConcepts` and `excludeFormatIds` across the session, and replaces the held suggestion.
- On failure, show the error with a retry, and leave the ordinary blank drafting flow usable so the user is never stuck.

- [ ] **Step 1: Pass the flag through the page**

In `app/(app)/config/draft/page.tsx`, widen the `searchParams` type and read the flag:

```tsx
  searchParams: Promise<{ category?: string; suggest?: string }>;
```

```tsx
  const { category: categoryId, suggest } = await searchParams;
```

and pass it to the wizard:

```tsx
  return <DraftWizard initialCategory={category} keys={keys} suggest={suggest === "1"} />;
```

- [ ] **Step 2: Add suggest state to the wizard**

In `app/(app)/config/draft/draft-wizard.tsx`, add to the imports:

```tsx
import { useEffect, useRef, useState } from "react";
import { suggestionToTurns, type SuggestResponse } from "@/lib/athena/suggest-category";
```

(replacing the existing `import { useState } from "react";`)

Extend `Props`:

```tsx
interface Props {
  initialCategory: Category | null;
  keys: { anthropic: boolean; kie: boolean };
  suggest?: boolean;
}
```

and the signature:

```tsx
export function DraftWizard({ initialCategory, keys, suggest = false }: Props) {
```

Add state beside the existing slots:

```tsx
  // Suggest mode. The suggestion is held client-side and persists nothing
  // until the user engages — otherwise every re-roll would litter Config with
  // abandoned categories.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [excludeConcepts, setExcludeConcepts] = useState<string[]>([]);
  const [excludeFormatIds, setExcludeFormatIds] = useState<string[]>([]);
```

- [ ] **Step 3: Fetch the suggestion on mount, and on re-roll**

Add this above `send`:

```tsx
  async function fetchSuggestion() {
    setSuggesting(true);
    setError("");
    try {
      const res = await fetch("/api/categories/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludeConcepts, excludeFormatIds }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const suggestion = json as SuggestResponse;
      // Replaces the held suggestion rather than appending to it: a re-roll
      // is a different proposal, not the next turn of a conversation.
      setTurns(suggestionToTurns(suggestion));
      setSuggestionId(suggestion.suggestionId);
      setExcludeConcepts((prev) => [...prev, suggestion.sample.concept]);
      if (suggestion.formatId) {
        setExcludeFormatIds((prev) => [...prev, suggestion.formatId!]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  }

  // Fires once. The ref guards against React's development double-invoke,
  // which would otherwise bill two LLM calls and log two impressions.
  const suggestedOnce = useRef(false);
  useEffect(() => {
    if (!suggest || !keys.anthropic || suggestedOnce.current) return;
    suggestedOnce.current = true;
    void fetchSuggestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggest, keys.anthropic]);
```

- [ ] **Step 4: Send `suggestionId` on the first real turn**

In `send`, add the field to the request body:

```tsx
        body: JSON.stringify({
          turns: nextTurns,
          categoryId: categoryId ?? undefined,
          styleRefUrl: pendingStyleRef ?? undefined,
          suggestionId: suggestionId ?? undefined,
        }),
```

and clear it after a successful turn so a later turn cannot re-trigger writeback, beside the existing `setPendingStyleRef(null)`:

```tsx
      setSuggestionId(null);
```

- [ ] **Step 5: Render the suggest-mode UI**

Replace the `{!started && (` opening line so the start screen is skipped in suggest mode:

```tsx
            {suggesting && (
              <p className="text-sm text-muted-foreground">Reading your brand and drafting a suggestion…</p>
            )}

            {!started && !suggesting && suggest && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Couldn&apos;t draft a suggestion.
                </p>
                <div className="flex gap-2">
                  <Button onClick={() => void fetchSuggestion()}>Try again</Button>
                  <Button variant="outline" render={<Link href="/config/draft" />}>
                    Build my own instead
                  </Button>
                </div>
              </div>
            )}

            {!started && !suggesting && !suggest && (
```

Then add a re-roll button inside the `{started && (` block, directly above the composer's `<div className="flex gap-2">`:

```tsx
                {suggestionId && (
                  <Button variant="outline" size="sm" disabled={suggesting || sending}
                    onClick={() => void fetchSuggestion()}>
                    Suggest a different one
                  </Button>
                )}
```

- [ ] **Step 6: Verify it builds and the suite is green**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: no lint errors, no type errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/config/draft/page.tsx" "app/(app)/config/draft/draft-wizard.tsx"
git commit -m "feat: seed the draft wizard from a brand-grounded suggestion"
```

---

### Task 7: Entry points

**Files:**
- Modify: `app/(app)/config/category-manager.tsx:288-290`
- Modify: `app/(app)/onboarding/onboarding-steps.tsx:89-94`
- Modify: `app/(app)/onboarding/page.tsx`

**Interfaces:**
- Consumes: `/config/draft?suggest=1` (Task 6).
- Produces: two user-reachable entry points, both disabled when the brand has no `business_name`.

**Context you need:** `app/(app)/onboarding/page.tsx:21` already computes `const brandDone = Boolean(brand?.business_name?.trim());` and passes it into `onboarding-steps.tsx`, so the onboarding gate needs no new query. `category-manager.tsx` is a client component and does not know about the brand — but `app/(app)/config/page.tsx:27-28` already loads `brandRow` for `BrandSection` and renders `<CategoryManager>` directly at line 40, so threading one prop is a two-line change with no new query.

- [ ] **Step 1: Add the Config entry point**

In `app/(app)/config/category-manager.tsx`, replace the block at lines 286-291:

```tsx
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Add a new category</p>
            <div className="flex gap-2">
              {brandDone && (
                <Button render={<Link href="/config/draft?suggest=1" />} variant="outline" size="sm">
                  ✨ Suggest one
                </Button>
              )}
              <Button render={<Link href="/config/draft" />} variant="outline" size="sm">
                ✨ Draft with AI
              </Button>
            </div>
          </div>
```

Thread `brandDone` in: add `brandDone: boolean` to the `CategoryManager` props interface and destructure it in the signature. Then in `app/(app)/config/page.tsx`, change line 40 to pass it from the `brandRow` the page already loads at lines 27-28:

```tsx
      <CategoryManager
        categories={(data ?? []) as Category[]}
        groups={groups}
        brandDone={Boolean((brandRow as BrandProfile | null)?.business_name?.trim())}
      />
```

Do not add a second brand query — the row is already in scope.

- [ ] **Step 2: Add the onboarding entry point**

In `app/(app)/onboarding/onboarding-steps.tsx`, replace lines 89-94:

```tsx
      <StepShell index={2} title="First post type" state={states[1]}>
        <p className="mb-3 text-sm text-muted-foreground">
          Draft a post type — it opens the same wizard you&apos;ll reuse later from Config.
        </p>
        <div className="flex flex-wrap gap-2">
          {brandDone && (
            <Button render={<Link href="/config/draft?suggest=1" />}>Suggest one for me</Button>
          )}
          <Button render={<Link href="/config/draft" />} variant={brandDone ? "outline" : undefined}>
            Build my own
          </Button>
        </div>
        {!brandDone && (
          <p className="mt-2 text-xs text-muted-foreground">
            Finish brand setup above and we can suggest a post type built on it.
          </p>
        )}
      </StepShell>
```

`brandDone` is already a prop on this component (declared at line 48), so no new plumbing is needed here.

- [ ] **Step 3: Verify it builds and the suite is green**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: no lint errors, no type errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/config/category-manager.tsx" "app/(app)/config/page.tsx" "app/(app)/onboarding/onboarding-steps.tsx"
git commit -m "feat: offer a suggested post type from Config and onboarding"
```

---

# Phase 2 — Observed seeding

Lets genuinely observed formats enter the library so they start outranking invented ones. Everything in Phase 1 works without this.

---

### Task 8: Draft a format from a screenshot

**Files:**
- Create: `lib/athena/draft-format.ts`
- Create: `tests/draft-format.test.ts`
- Create: `app/api/formats/draft/route.ts`

**Interfaces:**
- Consumes: `brandBlock` is deliberately NOT used here — a format is brand-independent. Uses `requireUser`, `requireAnthropicKey`, `createAnthropicClient`, `friendlyLlmError`.
- Produces:
  - `FormatDraftOutput` — Zod schema with `name`, `structure`, `why_it_works`, `source_example`, `brand_fit`.
  - `buildFormatDraftSystemPrompt(): string`
  - `formatDraftMessages(screenshotUrls: string[], note: string)` — the `MessageParam[]` for the vision call.
  - `POST /api/formats/draft` returning `{ draft: { name, structure, why_it_works, source_example, brand_fit } }`.

**Context you need:** A format entry is **brand-independent** — it is the reusable shape, which a different brand should be able to carry. Do not put brand context in this prompt; that is what makes the entry reusable and what lets a scraper feed the same function later. Multiple screenshots are the slides of ONE post, in order — the existing draft prompt already states this at `lib/athena/draft-category.ts:114-117`, and the same rule applies. Build the vision message the same way `toAnthropicMessages` does at `lib/athena/draft-category.ts:130-145`.

- [ ] **Step 1: Write the failing tests**

Create `tests/draft-format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildFormatDraftSystemPrompt, formatDraftMessages } from "@/lib/athena/draft-format";

describe("buildFormatDraftSystemPrompt", () => {
  it("asks for a brand-independent, reusable structure", () => {
    const out = buildFormatDraftSystemPrompt();
    expect(out).toContain("reusable");
    expect(out.toLowerCase()).toContain("different brand");
  });

  it("reads multiple screenshots as one post in order", () => {
    expect(buildFormatDraftSystemPrompt()).toContain("slides of ONE post");
  });

  it("forbids copying the example's visual identity", () => {
    const out = buildFormatDraftSystemPrompt();
    expect(out).toContain("NEVER");
    expect(out.toLowerCase()).toContain("colors");
  });

  it("forbids inventing engagement numbers about the example", () => {
    expect(buildFormatDraftSystemPrompt().toLowerCase()).toContain("do not invent");
  });
});

describe("formatDraftMessages", () => {
  it("puts every screenshot in a single user turn, in order", () => {
    const [msg] = formatDraftMessages(["https://a/1.png", "https://a/2.png"], "");
    expect(msg.role).toBe("user");
    const content = msg.content as Array<{ type: string; source?: { url: string } }>;
    expect(content.filter((c) => c.type === "image")).toHaveLength(2);
    expect(content[0].source?.url).toBe("https://a/1.png");
    expect(content[1].source?.url).toBe("https://a/2.png");
  });

  it("always ends with a text block, even with no note", () => {
    const [msg] = formatDraftMessages(["https://a/1.png"], "");
    const content = msg.content as Array<{ type: string; text?: string }>;
    expect(content[content.length - 1].type).toBe("text");
    expect(content[content.length - 1].text).toBeTruthy();
  });

  it("carries the note when one is given", () => {
    const [msg] = formatDraftMessages([], "a16z's 'startups that need to exist' posts");
    const content = msg.content as Array<{ type: string; text?: string }>;
    expect(content[content.length - 1].text).toContain("startups that need to exist");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/draft-format.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/draft-format`.

- [ ] **Step 3: Implement the module**

Create `lib/athena/draft-format.ts`:

```ts
import { z } from "zod";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export const FormatDraftOutput = z.object({
  name: z.string().describe("Short memorable name for the structure"),
  structure: z.string().describe(
    "The slide-by-slide shape: how many panels, what job each one does, in order",
  ),
  why_it_works: z.string().describe("Why this structure works mechanically, in one or two sentences"),
  source_example: z.string().describe(
    "What this was taken from, described only as far as it can be seen. Empty string if unknown.",
  ),
  brand_fit: z.string().describe("What kind of brand can carry this structure"),
});

// Deliberately brand-free. A format entry is the reusable shape — binding it
// to one brand at capture time is what would stop a different brand from
// using it, and would stop a scraper from feeding this same function later.
export function buildFormatDraftSystemPrompt(): string {
  return [
    "You are cataloguing a social post FORMAT: the reusable structure behind a post, written so a completely different brand could carry it.",
    "",
    "Extract ONLY structure and copy pattern: panel count, the job each panel does, pacing, how the text is worded.",
    "Multiple screenshots are the slides of ONE post, in order — read them as one sequential carousel, not as separate posts.",
    "",
    "NEVER record the example's colors, palette, fonts, photography style, or illustration style. Those belong to whoever made it. The structure is what transfers; the look does not.",
    "",
    "HONESTY RULES:",
    "- Do not invent engagement numbers, follower counts, or dates. You cannot see them.",
    "- Do not claim the format is currently popular or trending. You cannot verify that.",
    "- Describe source_example only as far as you can actually see it. An empty string is better than a guess.",
    "",
    "why_it_works must be mechanical — what the structure does to a reader's attention — not a claim about performance.",
  ].join("\n");
}

export function formatDraftMessages(screenshotUrls: string[], note: string): MessageParam[] {
  return [{
    role: "user",
    content: [
      ...screenshotUrls.map((url) => ({
        type: "image" as const,
        source: { type: "url" as const, url },
      })),
      {
        type: "text" as const,
        text: note.trim() || "Catalogue the format shown in these screenshots.",
      },
    ],
  }];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/draft-format.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the route**

Create `app/api/formats/draft/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createAnthropicClient } from "@/lib/anthropic";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import {
  FormatDraftOutput, buildFormatDraftSystemPrompt, formatDraftMessages,
} from "@/lib/athena/draft-format";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const FORMAT_DRAFT_MAX_TOKENS = 2000;

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const screenshotUrls = Array.isArray(body?.screenshotUrls)
    ? body.screenshotUrls.filter((u: unknown): u is string => typeof u === "string")
    : [];
  const note = typeof body?.note === "string" ? body.note : "";

  if (!screenshotUrls.length && !note.trim()) {
    return NextResponse.json(
      { error: "Add a screenshot or describe the format first" }, { status: 400 });
  }

  try {
    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "format_draft",
    });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: FORMAT_DRAFT_MAX_TOKENS,
      system: buildFormatDraftSystemPrompt(),
      messages: formatDraftMessages(screenshotUrls, note),
      output_config: { format: zodOutputFormat(FormatDraftOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error(`format draft returned no parseable output (stop_reason: ${response.stop_reason})`);
    }
    return NextResponse.json({ draft: parsed });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("format draft failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
```

- [ ] **Step 6: Verify and commit**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass; no type errors.

```bash
git add lib/athena/draft-format.ts tests/draft-format.test.ts app/api/formats/draft/route.ts
git commit -m "feat: draft a reusable format entry from screenshots"
```

---

### Task 9: The `/config/formats` surface

**Files:**
- Create: `app/(app)/config/formats/page.tsx`
- Create: `app/(app)/config/formats/formats-manager.tsx`
- Modify: `app/(app)/config/actions.ts`

**Interfaces:**
- Consumes: `POST /api/formats/draft` (Task 8); `uploadStyleRefImage` from `app/(app)/config/actions.ts:110`; `Format` from `@/lib/types`.
- Produces: server actions `saveFormat(formData)` and `deleteFormat(id)`; a page listing the tenant's own formats plus the shared ones read-only, with an add-from-screenshot flow.

**Context you need — read `node_modules/next/dist/docs/` before writing this page.** `uploadStyleRefImage` already posts an image to Cloudinary and returns `{ url }` — reuse it rather than writing a second upload path. Shared formats are read-only in this surface because RLS blocks the app from updating them at all; render them in a separate labelled group rather than letting a user click into an edit that will silently fail.

- [ ] **Step 1: Add the server actions**

Append to `app/(app)/config/actions.ts`:

```ts
// Formats are always written as origin 'observed' from this surface —
// 'invented' rows are only ever created by suggestion writeback. shared is
// never set here: promoting a format is a manual step in Supabase, and RLS
// enforces that independently of this action.
export async function saveFormat(
  formData: FormData,
): Promise<{ error?: string }> {
  const user = await requireUser();
  const supabase = await createServerSupabase();

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const structure = String(formData.get("structure") ?? "").trim();
  if (!name) return { error: "Name is required" };
  if (!structure) return { error: "Structure is required" };

  const fields = {
    name,
    structure,
    why_it_works: String(formData.get("why_it_works") ?? "").trim(),
    source_example: String(formData.get("source_example") ?? "").trim(),
    brand_fit: String(formData.get("brand_fit") ?? "").trim(),
    screenshot_url: String(formData.get("screenshot_url") ?? "").trim(),
    active: formData.get("active") === "on",
  };

  const { error } = id
    ? await supabase.from("formats").update(fields).eq("id", id)
    : await supabase.from("formats").insert({
        ...fields, user_id: user.id, origin: "observed", shared: false,
      });
  if (error) return { error: error.message };

  revalidatePath("/config/formats");
  return {};
}

export async function deleteFormat(id: string): Promise<{ error?: string }> {
  await requireUser();
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("formats").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/config/formats");
  return {};
}
```

Check the top of `actions.ts` for the existing imports of `requireUser`, `createServerSupabase`, and `revalidatePath` and reuse them rather than re-importing.

- [ ] **Step 2: Write the page**

Create `app/(app)/config/formats/page.tsx`:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getKeyStatus } from "@/lib/settings/user-secrets";
import { FormatsManager } from "./formats-manager";
import type { Format } from "@/lib/types";

export default async function FormatsPage() {
  const user = await requireUser();
  const supabase = await createServerSupabase();
  // RLS returns shared rows plus this tenant's own; split them here because
  // shared rows cannot be edited through the app at all.
  const { data } = await supabase
    .from("formats").select("*").order("created_at", { ascending: false });
  const all = (data ?? []) as Format[];
  const keys = await getKeyStatus(user.id);

  return (
    <FormatsManager
      own={all.filter((f) => f.user_id === user.id)}
      shared={all.filter((f) => f.user_id !== user.id)}
      hasAnthropicKey={keys.anthropic}
    />
  );
}
```

- [ ] **Step 3: Write the manager component**

Create `app/(app)/config/formats/formats-manager.tsx`:

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { saveFormat, deleteFormat, uploadStyleRefImage } from "../actions";
import type { Format } from "@/lib/types";

interface Draft {
  name: string;
  structure: string;
  why_it_works: string;
  source_example: string;
  brand_fit: string;
  screenshot_url: string;
}

const BLANK: Draft = {
  name: "", structure: "", why_it_works: "",
  source_example: "", brand_fit: "", screenshot_url: "",
};

export function FormatsManager({
  own, shared, hasAnthropicKey,
}: {
  own: Format[];
  shared: Format[];
  hasAnthropicKey: boolean;
}) {
  const [capture, setCapture] = useState<Draft | null>(null);
  const [screenshotUrls, setScreenshotUrls] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"upload" | "draft" | null>(null);
  const [error, setError] = useState("");

  async function uploadFiles(files: FileList) {
    setBusy("upload");
    setError("");
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await uploadStyleRefImage(fd);
      if (res.error || !res.url) { setError(`Upload failed: ${res.error ?? "no url"}`); break; }
      setScreenshotUrls((prev) => [...prev, res.url!]);
    }
    setBusy(null);
  }

  async function draftFromCapture() {
    setBusy("draft");
    setError("");
    try {
      const res = await fetch("/api/formats/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ screenshotUrls, note }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCapture({ ...json.draft, screenshot_url: screenshotUrls[0] ?? "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Format library</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Post structures worth reusing. Suggestions prefer these over inventing something new.
          Formats saved automatically from suggestions you kept are marked{" "}
          <span className="font-medium">invented</span>.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Add from a screenshot</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {!hasAnthropicKey ? (
            <p className="text-sm text-muted-foreground">
              Add your Anthropic API key in Config to catalogue a format from a screenshot.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Only the structure and copy pattern are recorded — never the example&apos;s colors or art style.
                For a carousel, upload one screenshot per slide, in order.
              </p>
              <input type="file" accept="image/*" multiple className="block text-sm"
                onChange={(e) => e.target.files?.length && uploadFiles(e.target.files)} />
              {busy === "upload" && <p className="text-xs text-muted-foreground">Uploading…</p>}
              {screenshotUrls.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {screenshotUrls.map((u) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={u} src={u} alt="" className="h-24 rounded border object-cover" />
                  ))}
                </div>
              )}
              <div>
                <Label>Anything to add (optional)</Label>
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. a16z's 'startups that need to exist' posts" />
              </div>
              <Button disabled={busy !== null || (!screenshotUrls.length && !note.trim())}
                onClick={() => void draftFromCapture()}>
                {busy === "draft" ? "Reading it…" : "Catalogue this format"}
              </Button>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {capture && (
        <FormatForm
          draft={capture}
          title="Review before saving"
          onDone={() => { setCapture(null); setScreenshotUrls([]); setNote(""); }}
        />
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-medium">Your formats</h2>
        {own.length === 0 && (
          <p className="text-sm text-muted-foreground">
            None yet. Formats appear here as you catalogue them, and automatically when you keep a suggestion.
          </p>
        )}
        {own.map((f) => (
          <FormatForm key={f.id} format={f} draft={toDraft(f)} title={f.name} />
        ))}
      </div>

      {shared.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Shared library</h2>
          <p className="text-xs text-muted-foreground">
            Available to every account and read-only here — these are edited directly in Supabase.
          </p>
          {shared.map((f) => (
            <Card key={f.id}>
              <CardHeader><CardTitle className="text-base">{f.name}</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="whitespace-pre-wrap">{f.structure}</p>
                {f.why_it_works && (
                  <p className="text-muted-foreground">{f.why_it_works}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function toDraft(f: Format): Draft {
  return {
    name: f.name, structure: f.structure, why_it_works: f.why_it_works,
    source_example: f.source_example, brand_fit: f.brand_fit,
    screenshot_url: f.screenshot_url,
  };
}

// Every field round-trips, including screenshot_url as a hidden input.
// saveFormat writes every column in its payload, so a field the form omits
// is written back as an empty string on the next save — the same bug class
// proof_points/standing hit on the brand form.
function FormatForm({
  format, draft, title, onDone,
}: {
  format?: Format;
  draft: Draft;
  title: string;
  onDone?: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {format && <Badge variant="outline">{format.origin}</Badge>}
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          action={async (fd: FormData) => {
            const res = await saveFormat(fd);
            setError(res.error ?? "");
            if (!res.error) onDone?.();
          }}
        >
          <input type="hidden" name="id" value={format?.id ?? ""} />
          <input type="hidden" name="screenshot_url" value={draft.screenshot_url} />
          <div>
            <Label>Name</Label>
            <Input name="name" defaultValue={draft.name} />
          </div>
          <div>
            <Label>Structure</Label>
            <Textarea name="structure" rows={3} defaultValue={draft.structure} />
          </div>
          <div>
            <Label>Why it works</Label>
            <Textarea name="why_it_works" rows={2} defaultValue={draft.why_it_works} />
          </div>
          <div>
            <Label>Source example</Label>
            <Input name="source_example" defaultValue={draft.source_example} />
          </div>
          <div>
            <Label>Fits brands that</Label>
            <Textarea name="brand_fit" rows={2} defaultValue={draft.brand_fit} />
          </div>
          <div className="flex items-center gap-2">
            <Switch name="active" defaultChecked={format?.active ?? true} />
            <Label>Available to suggestions</Label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm">Save</Button>
            {format && (
              <Button type="button" variant="outline" size="sm"
                onClick={async () => {
                  const res = await deleteFormat(format.id);
                  setError(res.error ?? "");
                }}>
                Delete
              </Button>
            )}
            {onDone && (
              <Button type="button" variant="outline" size="sm" onClick={onDone}>Discard</Button>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
```

Two details to preserve if you restructure this:

- **Every field round-trips through the form**, including `screenshot_url` as a hidden input. `saveFormat` writes every column in its payload, so an omitted field is written back as an empty string on the next save.
- **Shared formats are rendered read-only**, not as a disabled edit form. RLS blocks the app from updating them at all, so an edit control there would fail silently.

- [ ] **Step 4: Link the page from Config**

In `app/(app)/config/page.tsx`, add a link beside the existing "Run setup again" link in the flex row at lines 33-37, so the two page-level links sit together:

```tsx
      <div className="flex justify-end gap-4">
        <Link href="/config/formats" className="text-sm text-primary underline-offset-4 hover:underline">
          Format library
        </Link>
        <Link href="/onboarding" className="text-sm text-primary underline-offset-4 hover:underline">
          Run setup again
        </Link>
      </div>
```

- [ ] **Step 5: Verify it builds and the suite is green**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: no lint errors, no type errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/config/formats" "app/(app)/config/actions.ts" "app/(app)/config/page.tsx"
git commit -m "feat: format library surface with screenshot capture"
```

---

## Final verification

- [ ] **Run the full suite:** `npm test` — every test passes.
- [ ] **Typecheck:** `npx tsc --noEmit` — clean.
- [ ] **Lint:** `npm run lint` — clean.
- [ ] **Build:** `npm run build` — succeeds.
- [ ] **RLS (requires migration 0017 applied to dev Supabase):** `npm run verify-formats-rls` — prints `FORMATS RLS OK`.
- [ ] **Manual, with real keys:** open `/config/draft?suggest=1` on an account with a brand profile. Confirm a suggestion appears with a worked sample; re-roll and confirm the second proposal differs; send one refinement turn and confirm the category persists; then confirm in Supabase that `categories.source_format_id` is set, a `formats` row exists with `origin = 'invented'`, and the `format_suggestions` row has `category_id` stamped.
- [ ] **Empty-brand path:** on an account with no `business_name`, confirm both suggest entry points are hidden and the ordinary "Build my own" flow still works.
