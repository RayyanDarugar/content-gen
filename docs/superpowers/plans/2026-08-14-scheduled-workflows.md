# Scheduled Workflows (Autopilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a category publish on its own — "a carousel a day in each of these five categories" — by reconciling a quota every few minutes against the existing idea → image → post pipeline.

**Architecture:** Two new tables (`autopilot_workflows`, one per category; `autopilot_runs`, one per attempt) and a new cron route `GET /api/jobs/autopilot`. Each tick asks per workflow: *has this category landed its quota this period?* If not, it opens or advances exactly one run by exactly one step. Every decision the tick makes lives in a pure function under `lib/autopilot/` with vitest coverage; the route and `tick.ts` are glue that reads the database and calls the pipeline functions that already exist.

**Tech Stack:** Next.js 16 App Router, Supabase (admin client for cron, RLS for the UI), vitest, `Intl.DateTimeFormat` for timezone math (no date library).

**Spec:** `docs/superpowers/specs/2026-08-14-scheduled-workflows-design.md` — read it before Task 1. Section references below (§4, §5, …) point at it.

## Global Constraints

- **This is not the Next.js you know.** Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/` before writing route handlers, server actions, or page components. Do not assume App Router conventions from memory.
- **`lib/**` mutation helpers take `userId` as a parameter and never authenticate.** They must never be exported from a `"use server"` file — every export there is a publicly POST-reachable endpoint. Thin actions call `requireUser()` and delegate. See the header comment in `lib/overlay-mutations.ts`.
- **Never spread caller input into a Supabase insert/update.** Enumerate columns explicitly. Same reasoning as `lib/overlay-mutations.ts`: server-action arguments arrive as deserialized JSON with the TypeScript shape erased, and a trailing spread lets a caller override an ownership column.
- **The admin client bypasses RLS**, so every query it makes must carry an explicit `.eq("user_id", …)` tenant predicate.
- **Migrations are applied by hand.** Write the file; do not attempt to run it against production. The final task lists it as a deploy step.
- **Test file naming:** `tests/<subject>.test.ts`, importing through the `@/` alias. `environment: node`.
- Run the full suite with `npm test`. Type-check with `npx tsc --noEmit`.

---

### Task 1: Schema and types

**Files:**
- Create: `supabase/migrations/0024_autopilot.sql`
- Modify: `lib/types.ts` (append at end)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `autopilot_workflows`, `autopilot_runs`; types `AutopilotPeriod`, `AutopilotWorkflow`, `AutopilotRunState`, `AutopilotSource`, `AutopilotRunStep`, `AutopilotRun`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0024_autopilot.sql`:

```sql
-- supabase/migrations/0024_autopilot.sql
-- Scheduled workflows / autopilot (spec 2026-08-14-scheduled-workflows-design.md).
--
-- Autopilot is a quota the system reconciles, not a job that fires at a time.
-- A workflow says "this category publishes N times per period"; a run is one
-- attempt at closing that gap. A failed attempt needs no retry machinery — it
-- simply leaves the gap open for the next tick, bounded by the caps below.

create table autopilot_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- unique: exactly one answer to "what is this category's cadence?"
  category_id uuid not null references categories(id) on delete cascade,
  posts_per_period int not null default 1 check (posts_per_period between 1 and 10),
  period text not null default 'day' check (period in ('day', 'week')),
  timezone text not null default 'America/Los_Angeles',
  max_attempts_per_period int not null default 3
    check (max_attempts_per_period between 1 and 10),
  auto_pause_after_failed_periods int not null default 3
    check (auto_pause_after_failed_periods >= 1),
  consecutive_failed_periods int not null default 0,
  -- The last local period this workflow was judged for. Null on a brand-new
  -- workflow, which is why the first sighting settles without judging.
  last_settled_period date,
  active boolean not null default true,
  paused_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (category_id)
);

-- No brand_id column: the brand is read from the category (categories.brand_id),
-- which is what generateIdeas needs for loadBrandContext. A second copy would
-- be one more enumerated column to keep in sync, and this codebase has already
-- been bitten by that.
create table autopilot_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references autopilot_workflows(id) on delete cascade,
  category_key text not null,
  period_start date not null,
  attempt_no int not null,
  state text not null
    check (state in ('sourcing', 'awaiting_images', 'posting', 'succeeded', 'failed')),
  source text not null default ''
    check (source in ('', 'retry_images', 'ready_images', 'approved_idea', 'generated')),
  -- set null, never cascade: deleting an idea must not erase the record of the
  -- run that published it.
  idea_id uuid references ideas(id) on delete set null,
  post_group_id uuid,
  error text not null default '',
  -- Append-only [{at, step, detail}] display log, so the UI can say what
  -- happened rather than only where it stopped. Never read for control flow.
  steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Two overlapping ticks cannot both open the same attempt.
  unique (workflow_id, period_start, attempt_no)
);

create index autopilot_runs_workflow_period_idx
  on autopilot_runs(workflow_id, period_start);
-- The tick's hottest read: "does this workflow have a run in flight?"
create index autopilot_runs_live_idx on autopilot_runs(workflow_id)
  where state in ('sourcing', 'awaiting_images', 'posting');
-- Claim check during sourcing: "is this idea already spoken for?"
create index autopilot_runs_idea_idx on autopilot_runs(idea_id)
  where state in ('sourcing', 'awaiting_images', 'posting');

alter table autopilot_workflows enable row level security;
create policy "owner all" on autopilot_workflows for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table autopilot_runs enable row level security;
create policy "owner all" on autopilot_runs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger autopilot_workflows_updated_at before update on autopilot_workflows
  for each row execute function set_updated_at();
create trigger autopilot_runs_updated_at before update on autopilot_runs
  for each row execute function set_updated_at();
```

- [ ] **Step 2: Add the types**

Append to `lib/types.ts`:

```ts
export type AutopilotPeriod = "day" | "week";

// One row per category (unique on category_id): "this category publishes
// posts_per_period times per period, in this timezone."
export interface AutopilotWorkflow {
  id: string;
  user_id: string;
  category_id: string;
  posts_per_period: number;
  period: AutopilotPeriod;
  timezone: string;
  max_attempts_per_period: number;
  auto_pause_after_failed_periods: number;
  consecutive_failed_periods: number;
  last_settled_period: string | null;
  active: boolean;
  paused_reason: string;
  created_at: string;
  updated_at: string;
}

export type AutopilotRunState =
  | "sourcing" | "awaiting_images" | "posting" | "succeeded" | "failed";

// "" only ever appears on a run still in `sourcing` — the tier is recorded
// the moment one is chosen.
export type AutopilotSource =
  | "" | "retry_images" | "ready_images" | "approved_idea" | "generated";

export interface AutopilotRunStep {
  at: string;
  step: string;
  detail: string;
}

export interface AutopilotRun {
  id: string;
  user_id: string;
  workflow_id: string;
  category_key: string;
  period_start: string;
  attempt_no: number;
  state: AutopilotRunState;
  source: AutopilotSource;
  idea_id: string | null;
  post_group_id: string | null;
  error: string;
  steps: AutopilotRunStep[];
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0024_autopilot.sql lib/types.ts
git commit -m "feat: autopilot schema and types"
```

---

### Task 2: Period arithmetic

**Files:**
- Create: `lib/autopilot/period.ts`
- Test: `tests/autopilot-period.test.ts`

**Interfaces:**
- Consumes: `AutopilotPeriod` from Task 1.
- Produces: `periodStart(now: Date, timezone: string, period: AutopilotPeriod): string` returning `YYYY-MM-DD`; `periodStartUtc(periodStartDate: string, timezone: string): Date`.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-period.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { periodStart, periodStartUtc } from "@/lib/autopilot/period";

describe("periodStart", () => {
  it("uses the workflow's local calendar day, not UTC's", () => {
    // 2026-08-14T04:00Z is 2026-08-13 21:00 in Los Angeles.
    const now = new Date("2026-08-14T04:00:00Z");
    expect(periodStart(now, "America/Los_Angeles", "day")).toBe("2026-08-13");
    expect(periodStart(now, "UTC", "day")).toBe("2026-08-14");
  });

  it("rolls a weekly period back to the local ISO week's Monday", () => {
    // 2026-08-14 is a Friday.
    const now = new Date("2026-08-14T18:00:00Z");
    expect(periodStart(now, "UTC", "week")).toBe("2026-08-10");
  });

  it("treats Sunday as the END of its ISO week, not the start", () => {
    // 2026-08-16 is a Sunday; its ISO week began Monday the 10th.
    const now = new Date("2026-08-16T18:00:00Z");
    expect(periodStart(now, "UTC", "week")).toBe("2026-08-10");
  });

  it("handles a timezone ahead of UTC", () => {
    // 2026-08-13T20:00Z is already 2026-08-14 in Tokyo (UTC+9).
    const now = new Date("2026-08-13T20:00:00Z");
    expect(periodStart(now, "Asia/Tokyo", "day")).toBe("2026-08-14");
  });
});

describe("periodStartUtc", () => {
  it("resolves local midnight to the right instant", () => {
    expect(periodStartUtc("2026-08-14", "America/Los_Angeles").toISOString())
      .toBe("2026-08-14T07:00:00.000Z"); // PDT, UTC-7
    expect(periodStartUtc("2026-08-14", "UTC").toISOString())
      .toBe("2026-08-14T00:00:00.000Z");
  });

  it("uses the offset in force ON that date, across a DST boundary", () => {
    // US DST ends Sunday 2026-11-01. Midnight on the 1st is still PDT (-7);
    // midnight on the 2nd is PST (-8). A fixed offset would get one wrong.
    expect(periodStartUtc("2026-11-01", "America/Los_Angeles").toISOString())
      .toBe("2026-11-01T07:00:00.000Z");
    expect(periodStartUtc("2026-11-02", "America/Los_Angeles").toISOString())
      .toBe("2026-11-02T08:00:00.000Z");
  });

  it("handles the spring-forward side too", () => {
    // DST begins Sunday 2026-03-08; midnight that day is still PST (-8).
    expect(periodStartUtc("2026-03-08", "America/Los_Angeles").toISOString())
      .toBe("2026-03-08T08:00:00.000Z");
    expect(periodStartUtc("2026-03-09", "America/Los_Angeles").toISOString())
      .toBe("2026-03-09T07:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autopilot-period.test.ts`
Expected: FAIL — cannot resolve `@/lib/autopilot/period`.

- [ ] **Step 3: Write the implementation**

Create `lib/autopilot/period.ts`:

```ts
import type { AutopilotPeriod } from "@/lib/types";

// All timezone arithmetic here goes through Intl.DateTimeFormat rather than a
// date library — the only two questions autopilot ever asks are "what local
// calendar date is it?" and "when did that local date begin?", and both are
// answerable from formatted parts.

function localParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  // hourCycle h23 is load-bearing: with hour12:false alone, some ICU versions
  // render midnight as "24", which would push the reconstructed date a day
  // forward inside offsetMs below.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"), second: get("second"),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Monday-based index (Mon = 0 … Sun = 6) of a calendar date, computed with UTC
// arithmetic on the date alone — no timezone involved, because by this point
// the date is already the workflow's LOCAL date.
function mondayIndex(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // Sun = 0
  return (dow + 6) % 7;
}

// The local calendar date (YYYY-MM-DD) that `now` belongs to for this period
// kind: the local day itself, or its ISO week's Monday.
export function periodStart(now: Date, timezone: string, period: AutopilotPeriod): string {
  const { year, month, day } = localParts(now, timezone);
  if (period === "day") return `${year}-${pad(month)}-${pad(day)}`;
  const back = mondayIndex(year, month, day);
  const monday = new Date(Date.UTC(year, month - 1, day - back));
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

// How far the zone is from UTC at a given instant, in ms.
function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instant.getTime();
}

// The instant at which local midnight of `periodStartDate` occurred. Two
// passes, because the offset must be the one in force AT that instant, not at
// the naive UTC guess — on a DST-transition date those differ by an hour, and
// a one-hour error moves the lower bound of the landed-post count onto the
// wrong side of a real post.
export function periodStartUtc(periodStartDate: string, timezone: string): Date {
  const [year, month, day] = periodStartDate.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day));
  const first = new Date(guess.getTime() - offsetMs(guess, timezone));
  const settled = offsetMs(first, timezone);
  return new Date(guess.getTime() - settled);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autopilot-period.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/autopilot/period.ts tests/autopilot-period.test.ts
git commit -m "feat: autopilot period arithmetic"
```

---

### Task 3: Quota gap and period settlement

**Files:**
- Create: `lib/autopilot/quota.ts`
- Test: `tests/autopilot-quota.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `quotaGap(input: QuotaInput): QuotaDecision` and `settlePeriod(input: SettleInput): SettleDecision`, with the exact shapes below.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-quota.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { quotaGap, settlePeriod } from "@/lib/autopilot/quota";

describe("quotaGap", () => {
  const base = { landedGroups: 0, postsPerPeriod: 1, attemptsUsed: 0, maxAttempts: 3 };

  it("opens the next attempt when the quota is unmet and attempts remain", () => {
    expect(quotaGap(base)).toEqual({ action: "open", attemptNo: 1 });
    expect(quotaGap({ ...base, attemptsUsed: 2 })).toEqual({ action: "open", attemptNo: 3 });
  });

  it("is satisfied once enough distinct post groups have landed", () => {
    expect(quotaGap({ ...base, landedGroups: 1 })).toEqual({ action: "satisfied" });
    expect(quotaGap({ ...base, landedGroups: 2, postsPerPeriod: 2 })).toEqual({ action: "satisfied" });
  });

  it("counts a manual post toward the quota, so autopilot stands down", () => {
    // The caller does not distinguish origins; landedGroups is every
    // non-failed post group in the period.
    expect(quotaGap({ ...base, landedGroups: 1, attemptsUsed: 0 })).toEqual({ action: "satisfied" });
  });

  it("stops at the attempt cap even with the quota still unmet", () => {
    expect(quotaGap({ ...base, attemptsUsed: 3 })).toEqual({ action: "exhausted", attemptsUsed: 3 });
  });

  it("checks the quota before the cap — a met quota is never 'exhausted'", () => {
    expect(quotaGap({ ...base, landedGroups: 1, attemptsUsed: 3 })).toEqual({ action: "satisfied" });
  });
});

describe("settlePeriod", () => {
  const base = {
    lastSettledPeriod: "2026-08-13",
    currentPeriod: "2026-08-14",
    priorLandedGroups: 0,
    postsPerPeriod: 1,
    consecutiveFailedPeriods: 0,
    autoPauseAfterFailedPeriods: 3,
    lastError: "Buffer rejected the post",
  };

  it("does nothing when the period has not rolled over", () => {
    expect(settlePeriod({ ...base, currentPeriod: "2026-08-13" })).toEqual({ action: "none" });
  });

  it("records the first sighting without judging a period that never ran", () => {
    const d = settlePeriod({ ...base, lastSettledPeriod: null });
    expect(d).toEqual({
      action: "settle", consecutiveFailedPeriods: 0, active: true,
      pausedReason: "", lastSettledPeriod: "2026-08-14",
    });
  });

  it("bumps the failure counter when the prior period fell short", () => {
    const d = settlePeriod(base);
    expect(d).toMatchObject({ action: "settle", consecutiveFailedPeriods: 1, active: true });
  });

  it("resets the counter when the prior period met its quota", () => {
    const d = settlePeriod({ ...base, priorLandedGroups: 1, consecutiveFailedPeriods: 2 });
    expect(d).toMatchObject({ action: "settle", consecutiveFailedPeriods: 0, active: true });
  });

  it("auto-pauses on reaching the threshold, quoting the last error", () => {
    const d = settlePeriod({ ...base, consecutiveFailedPeriods: 2 });
    expect(d).toMatchObject({ action: "settle", consecutiveFailedPeriods: 3, active: false });
    if (d.action === "settle") {
      expect(d.pausedReason).toContain("3 periods");
      expect(d.pausedReason).toContain("Buffer rejected the post");
    }
  });

  it("still pauses when there is no error to quote", () => {
    const d = settlePeriod({ ...base, consecutiveFailedPeriods: 2, lastError: "" });
    expect(d).toMatchObject({ action: "settle", active: false });
    if (d.action === "settle") expect(d.pausedReason).toContain("3 periods");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autopilot-quota.test.ts`
Expected: FAIL — cannot resolve `@/lib/autopilot/quota`.

- [ ] **Step 3: Write the implementation**

Create `lib/autopilot/quota.ts`:

```ts
export interface QuotaInput {
  // Distinct non-failed post GROUPS in the period — a multi-channel post is
  // several rows of one publication.
  landedGroups: number;
  postsPerPeriod: number;
  attemptsUsed: number;
  maxAttempts: number;
}

export type QuotaDecision =
  | { action: "satisfied" }
  | { action: "exhausted"; attemptsUsed: number }
  | { action: "open"; attemptNo: number };

// The quota is checked BEFORE the cap: a period whose posts landed is
// satisfied no matter how many attempts it took to get there, and reporting
// it as "exhausted" would show a red state over a day that actually worked.
export function quotaGap(input: QuotaInput): QuotaDecision {
  if (input.landedGroups >= input.postsPerPeriod) return { action: "satisfied" };
  if (input.attemptsUsed >= input.maxAttempts) {
    return { action: "exhausted", attemptsUsed: input.attemptsUsed };
  }
  return { action: "open", attemptNo: input.attemptsUsed + 1 };
}

export interface SettleInput {
  lastSettledPeriod: string | null;
  currentPeriod: string;
  // Landed groups for lastSettledPeriod, bounded ABOVE by currentPeriod's
  // start — the caller must not let today's posts count toward yesterday.
  priorLandedGroups: number;
  postsPerPeriod: number;
  consecutiveFailedPeriods: number;
  autoPauseAfterFailedPeriods: number;
  lastError: string;
}

export type SettleDecision =
  | { action: "none" }
  | {
      action: "settle";
      consecutiveFailedPeriods: number;
      active: boolean;
      pausedReason: string;
      lastSettledPeriod: string;
    };

// Called once per workflow per period rollover. Judges the period just ended,
// then records that the current one is now the open period.
//
// Only the LAST settled period is judged, even if several elapsed while the
// app was idle. Counting untouched periods as failures would auto-pause a
// workflow for the app being down rather than for anything the workflow did.
export function settlePeriod(input: SettleInput): SettleDecision {
  if (input.lastSettledPeriod === input.currentPeriod) return { action: "none" };

  // A workflow seen for the first time has no prior period to judge.
  if (input.lastSettledPeriod === null) {
    return {
      action: "settle",
      consecutiveFailedPeriods: input.consecutiveFailedPeriods,
      active: true,
      pausedReason: "",
      lastSettledPeriod: input.currentPeriod,
    };
  }

  const met = input.priorLandedGroups >= input.postsPerPeriod;
  const failed = met ? 0 : input.consecutiveFailedPeriods + 1;
  const active = failed < input.autoPauseAfterFailedPeriods;
  const pausedReason = active
    ? ""
    : `missed quota ${failed} periods running` +
      (input.lastError ? `; last error: ${input.lastError}` : "");

  return {
    action: "settle",
    consecutiveFailedPeriods: failed,
    active,
    pausedReason,
    lastSettledPeriod: input.currentPeriod,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autopilot-quota.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/autopilot/quota.ts tests/autopilot-quota.test.ts
git commit -m "feat: autopilot quota gap and period settlement"
```

---

### Task 4: Sourcing tiers

**Files:**
- Create: `lib/autopilot/sourcing.ts`
- Test: `tests/autopilot-sourcing.test.ts`

**Interfaces:**
- Consumes: `IdeaStatus` from `lib/types.ts`.
- Produces: `IdeaCandidate`, `SourceInput`, `SourceDecision`, `selectSource(input: SourceInput): SourceDecision`, `IDEA_BATCH`.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-sourcing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectSource, type IdeaCandidate } from "@/lib/autopilot/sourcing";

function candidate(over: Partial<IdeaCandidate> = {}): IdeaCandidate {
  return {
    ideaId: "idea-ready",
    status: "generated",
    slideCount: 3,
    readySlideIndexes: [0, 1, 2],
    hasNonFailedPost: false,
    hasInFlightGeneration: false,
    claimedByLiveRun: false,
    createdAt: "2026-08-14T00:00:00Z",
    ...over,
  };
}

const budgeted = { candidates: [] as IdeaCandidate[], priorAttempt: null, ideaGenerationAvailable: true };

describe("selectSource", () => {
  it("tier 1: reuses the prior failed attempt's carousel, carrying its post group", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({ ideaId: "idea-a" }), candidate({ ideaId: "idea-b" })],
      priorAttempt: { ideaId: "idea-b", postGroupId: "group-1" },
    });
    expect(d).toEqual({
      action: "post", source: "retry_images", ideaId: "idea-b", postGroupId: "group-1",
    });
  });

  it("falls through to tier 2 when the prior attempt's idea is no longer postable", () => {
    // Its post actually queued on a retry elsewhere — it must not go out twice.
    const d = selectSource({
      ...budgeted,
      candidates: [
        candidate({ ideaId: "idea-b", hasNonFailedPost: true }),
        candidate({ ideaId: "idea-a" }),
      ],
      priorAttempt: { ideaId: "idea-b", postGroupId: "group-1" },
    });
    expect(d).toEqual({
      action: "post", source: "ready_images", ideaId: "idea-a", postGroupId: null,
    });
  });

  it("tier 2: takes the OLDEST fully-ready unposted carousel", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [
        candidate({ ideaId: "newer", createdAt: "2026-08-14T10:00:00Z" }),
        candidate({ ideaId: "older", createdAt: "2026-08-12T10:00:00Z" }),
      ],
    });
    expect(d).toMatchObject({ action: "post", ideaId: "older" });
  });

  it("tier 2 skips a partially-generated carousel", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({ readySlideIndexes: [0, 1] })],
    });
    expect(d).toEqual({ action: "generate_ideas", source: "generated" });
  });

  it("tier 2 skips a carousel another live run already claimed", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({ claimedByLiveRun: true })],
    });
    expect(d).toEqual({ action: "generate_ideas", source: "generated" });
  });

  it("tier 3: submits an approved idea rather than paying to write a new one", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({ ideaId: "appr", status: "approved", readySlideIndexes: [] })],
    });
    expect(d).toEqual({ action: "submit_images", source: "approved_idea", ideaId: "appr" });
  });

  it("tier 3 skips an approved idea that already has images in flight", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({
        status: "approved", readySlideIndexes: [], hasInFlightGeneration: true,
      })],
    });
    expect(d).toEqual({ action: "generate_ideas", source: "generated" });
  });

  it("tier 4: generates fresh material when nothing is on the shelf", () => {
    expect(selectSource(budgeted)).toEqual({ action: "generate_ideas", source: "generated" });
  });

  it("defers instead of generating when the tick's generation budget is spent", () => {
    const d = selectSource({ ...budgeted, ideaGenerationAvailable: false });
    expect(d.action).toBe("defer");
  });

  it("still posts ready images even with the generation budget spent", () => {
    const d = selectSource({
      candidates: [candidate()], priorAttempt: null, ideaGenerationAvailable: false,
    });
    expect(d).toMatchObject({ action: "post", source: "ready_images" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autopilot-sourcing.test.ts`
Expected: FAIL — cannot resolve `@/lib/autopilot/sourcing`.

- [ ] **Step 3: Write the implementation**

Create `lib/autopilot/sourcing.ts`:

```ts
import type { IdeaStatus } from "@/lib/types";

// How many ideas one tier-4 generation call asks for. The chosen one is
// approved and submitted; the rest stay at pending_review as inventory for the
// human queue and for tomorrow's tier 3. Two extra ideas in a call already
// being made cost almost nothing.
export const IDEA_BATCH = 3;

export interface IdeaCandidate {
  ideaId: string;
  status: IdeaStatus;
  slideCount: number;
  // Slide indexes resolvable to a succeeded generation UNDER THE CURRENT
  // ANCHOR — i.e. resolveValidSlides output, not a raw succeeded count.
  readySlideIndexes: number[];
  // Any prior post covering one of this idea's generations that did not fail.
  hasNonFailedPost: boolean;
  hasInFlightGeneration: boolean;
  claimedByLiveRun: boolean;
  createdAt: string;
}

export interface SourceInput {
  candidates: IdeaCandidate[];
  // The idea and post group of an earlier attempt in THIS period, if any.
  priorAttempt: { ideaId: string; postGroupId: string | null } | null;
  // Whether this tick still has its one idea-generation slot.
  ideaGenerationAvailable: boolean;
}

export type SourceDecision =
  | {
      action: "post";
      source: "retry_images" | "ready_images";
      ideaId: string;
      postGroupId: string | null;
    }
  | { action: "submit_images"; source: "approved_idea"; ideaId: string }
  | { action: "generate_ideas"; source: "generated" }
  | { action: "defer"; reason: string };

function isPostable(c: IdeaCandidate): boolean {
  if (c.status !== "generated") return false;
  if (c.hasNonFailedPost || c.claimedByLiveRun) return false;
  const ready = new Set(c.readySlideIndexes);
  for (let i = 0; i < c.slideCount; i++) if (!ready.has(i)) return false;
  return true;
}

function oldestFirst(a: IdeaCandidate, b: IdeaCandidate): number {
  return a.createdAt.localeCompare(b.createdAt);
}

// Tiers, in order. The first that yields material wins, and the tier is
// recorded on the run so the UI can say where the post came from.
export function selectSource(input: SourceInput): SourceDecision {
  const postable = input.candidates.filter(isPostable).sort(oldestFirst);

  // Tier 1 — the prior failed attempt's own carousel. A Buffer rejection
  // leaves the idea unposted with only failed post rows, so the SAME images
  // should go out again rather than being regenerated. Its post_group_id
  // rides along so createPostForUser's pre-post cleanup replaces the failed
  // rows instead of leaving a permanent "1 queued · 1 failed" ghost.
  if (input.priorAttempt) {
    const again = postable.find((c) => c.ideaId === input.priorAttempt!.ideaId);
    if (again) {
      return {
        action: "post", source: "retry_images",
        ideaId: again.ideaId, postGroupId: input.priorAttempt.postGroupId,
      };
    }
  }

  // Tier 2 — anything already generated and unposted, oldest first, so the
  // shelf drains in order rather than the newest carousel being posted forever.
  if (postable.length) {
    return { action: "post", source: "ready_images", ideaId: postable[0].ideaId, postGroupId: null };
  }

  // Tier 3 — an approved idea that has never been imaged.
  const approved = input.candidates
    .filter((c) => c.status === "approved" && !c.hasInFlightGeneration && !c.claimedByLiveRun)
    .sort(oldestFirst);
  if (approved.length) {
    return { action: "submit_images", source: "approved_idea", ideaId: approved[0].ideaId };
  }

  // Tier 4 — make new material, but only if this tick still has its slot. A
  // deferred workflow simply wins the slot on a later tick: whoever takes it
  // moves to awaiting_images and stops competing for it.
  if (!input.ideaGenerationAvailable) {
    return { action: "defer", reason: "idea-generation budget spent this tick" };
  }
  return { action: "generate_ideas", source: "generated" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autopilot-sourcing.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/autopilot/sourcing.ts tests/autopilot-sourcing.test.ts
git commit -m "feat: autopilot sourcing tiers"
```

---

### Task 5: The awaiting-images decision

**Files:**
- Create: `lib/autopilot/run-step.ts`
- Test: `tests/autopilot-run-step.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `IMAGE_DEADLINE_MINUTES`, `AwaitingInput`, `AwaitingDecision`, `decideAwaitingImages(input: AwaitingInput): AwaitingDecision`.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-run-step.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideAwaitingImages, IMAGE_DEADLINE_MINUTES } from "@/lib/autopilot/run-step";

const startedAt = "2026-08-14T12:00:00Z";
const base = {
  slideCount: 3,
  readySlideIndexes: [] as number[],
  hasInFlightGeneration: true,
  runCreatedAt: startedAt,
  now: new Date("2026-08-14T12:05:00Z"),
};

describe("decideAwaitingImages", () => {
  it("posts once every declared slide has resolved", () => {
    expect(decideAwaitingImages({ ...base, readySlideIndexes: [0, 1, 2] }))
      .toEqual({ action: "post" });
  });

  it("waits while generations are still in flight", () => {
    expect(decideAwaitingImages({ ...base, readySlideIndexes: [0] }))
      .toEqual({ action: "wait" });
  });

  it("waits through the gap between the anchor landing and fan-out starting", () => {
    // Nothing in flight yet the deadline has not passed: the poll cron fans
    // out on its own tick, so this is a normal gap, not a stall.
    expect(decideAwaitingImages({ ...base, readySlideIndexes: [0], hasInFlightGeneration: false }))
      .toEqual({ action: "wait" });
  });

  it("fails the run once nothing is in flight past the deadline", () => {
    const d = decideAwaitingImages({
      ...base,
      readySlideIndexes: [0],
      hasInFlightGeneration: false,
      now: new Date(Date.parse(startedAt) + (IMAGE_DEADLINE_MINUTES + 1) * 60_000),
    });
    expect(d.action).toBe("fail");
    if (d.action === "fail") {
      expect(d.error).toContain("1 of 3");
      expect(d.error).toContain(String(IMAGE_DEADLINE_MINUTES));
    }
  });

  it("keeps waiting past the deadline while work is still in flight", () => {
    // A slow Kie queue is not a stall — the poll cron's own cap ends it.
    expect(decideAwaitingImages({
      ...base,
      hasInFlightGeneration: true,
      now: new Date(Date.parse(startedAt) + (IMAGE_DEADLINE_MINUTES + 1) * 60_000),
    })).toEqual({ action: "wait" });
  });

  it("posts a complete carousel even past the deadline", () => {
    expect(decideAwaitingImages({
      ...base,
      readySlideIndexes: [0, 1, 2],
      hasInFlightGeneration: false,
      now: new Date(Date.parse(startedAt) + (IMAGE_DEADLINE_MINUTES + 1) * 60_000),
    })).toEqual({ action: "post" });
  });

  it("returns the same decision when called twice on the same state", () => {
    const input = { ...base, readySlideIndexes: [0, 1, 2] };
    expect(decideAwaitingImages(input)).toEqual(decideAwaitingImages(input));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autopilot-run-step.test.ts`
Expected: FAIL — cannot resolve `@/lib/autopilot/run-step`.

- [ ] **Step 3: Write the implementation**

Create `lib/autopilot/run-step.ts`:

```ts
// How long a run may sit in awaiting_images with nothing in flight before it
// is treated as stalled. Generous relative to a normal carousel (single-digit
// minutes) because the poll cron retries slides on its own schedule, and
// failing early would burn an attempt on work that was about to finish.
export const IMAGE_DEADLINE_MINUTES = 30;

export interface AwaitingInput {
  slideCount: number;
  readySlideIndexes: number[];
  hasInFlightGeneration: boolean;
  runCreatedAt: string;
  now: Date;
}

export type AwaitingDecision =
  | { action: "post" }
  | { action: "wait" }
  | { action: "fail"; error: string };

// This step OBSERVES; it never acts. The poll cron owns fan-out, compositing,
// and slide retries — autopilot only reads what that work has produced.
export function decideAwaitingImages(input: AwaitingInput): AwaitingDecision {
  const ready = new Set(input.readySlideIndexes);
  let complete = true;
  for (let i = 0; i < input.slideCount; i++) if (!ready.has(i)) complete = false;
  if (complete) return { action: "post" };

  // Something is still cooking — including the ordinary gap where the anchor
  // has landed and the poll cron has not yet fanned out.
  if (input.hasInFlightGeneration) return { action: "wait" };

  const elapsedMs = input.now.getTime() - Date.parse(input.runCreatedAt);
  if (elapsedMs < IMAGE_DEADLINE_MINUTES * 60_000) return { action: "wait" };

  // The RUN fails; the idea does not. The poll cron deliberately leaves a
  // stuck carousel at "generating" so its good slides stay visible and
  // postable by hand, and autopilot must not override that.
  return {
    action: "fail",
    error:
      `images stalled: ${ready.size} of ${input.slideCount} slides ready after ` +
      `${IMAGE_DEADLINE_MINUTES} min with nothing in flight`,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autopilot-run-step.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/autopilot/run-step.ts tests/autopilot-run-step.test.ts
git commit -m "feat: autopilot awaiting-images decision"
```

---

### Task 6: Let a validated post ride Buffer's queue

**Files:**
- Modify: `app/api/posts/create/route.ts` (the `scheduleValidatedPost` signature, ~line 236)
- Test: `tests/schedule-validated-post.test.ts` (add one case)

**Interfaces:**
- Consumes: nothing.
- Produces: `scheduleValidatedPost(userId, { …, scheduledAt: string | null, … })` — autopilot passes `null` so Buffer's own queue picks the time.

**Context:** `createPostForUser` already accepts `scheduledAt: string | null` and `postToBuffer` already treats a missing value as "use the queue" (`scheduledAt ?? undefined`). Only `scheduleValidatedPost`'s own parameter type is narrower than what it forwards. Reusing this function rather than writing a parallel posting path in the cron is deliberate — its comment warns that its validation must never diverge from the HTTP route's, and a second copy would be exactly that divergence.

- [ ] **Step 1: Write the failing test**

Add to `tests/schedule-validated-post.test.ts`, inside the existing `describe("scheduleValidatedPost")` block:

```ts
  it("accepts scheduledAt: null so a post can ride Buffer's own queue", async () => {
    // Reaches the same duplicate-channel rejection as the case above, which
    // proves null passed the type boundary and the call ran — the point here
    // is that `scheduledAt: null` compiles and is forwarded, not that this
    // particular submission succeeds.
    await expect(
      scheduleValidatedPost("user-1", {
        categoryKey: "cat1",
        generationIds: ["gen-1"],
        channels: [
          { connectionId: "conn-1", channelId: "chan-1", service: "instagram", caption: "hi" },
          { connectionId: "conn-1", channelId: "chan-1", service: "instagram", caption: "hi again" },
        ],
        caption: "hi",
        scheduledAt: null,
        postGroupId: null,
      }),
    ).rejects.toThrow("duplicate channel in selection");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/schedule-validated-post.test.ts`
Expected: FAIL — TypeScript rejects `null` for `scheduledAt`. If vitest transpiles without type-checking and the test passes, run `npx tsc --noEmit` and confirm it reports the type error there; that is the failing signal for this step.

- [ ] **Step 3: Widen the parameter**

In `app/api/posts/create/route.ts`, change `scheduleValidatedPost`'s input type:

```ts
export async function scheduleValidatedPost(
  userId: string,
  input: { categoryKey: string; generationIds: string[]; channels: ChannelInput[]; caption: string; scheduledAt: string | null; postGroupId: string | null },
): Promise<{ postGroupId: string; results: ChannelResult[]; allFailed: boolean }> {
```

Add above the signature:

```ts
// scheduledAt is `string | null`, not `string`: createPostForUser and
// postToBuffer have always accepted "no time" to mean "ride the channel's
// Buffer queue", and autopilot (lib/autopilot/tick.ts) posts that way by
// design. Nothing else in the body changes — the value was already a
// pass-through.
```

- [ ] **Step 4: Run the tests and the type-check**

Run: `npx vitest run tests/schedule-validated-post.test.ts && npx tsc --noEmit`
Expected: PASS, and no type errors. The MCP `schedule_post` tool still passes a string and is unaffected.

- [ ] **Step 5: Commit**

```bash
git add app/api/posts/create/route.ts tests/schedule-validated-post.test.ts
git commit -m "feat: let scheduleValidatedPost ride Buffer's queue with a null time"
```

---

### Task 7: Workflow mutation helpers

**Files:**
- Create: `lib/autopilot/workflow-mutations.ts`
- Test: `tests/autopilot-workflow-mutations.test.ts`

**Interfaces:**
- Consumes: `AutopilotWorkflow`, `AutopilotRun`, `Category` from `lib/types.ts`.
- Produces: `WorkflowSettings`, `validateWorkflowSettings(s: WorkflowSettings): void`, `listWorkflowsForUser(userId, brandId)`, `upsertWorkflowForUser(userId, categoryId, settings)`, `setWorkflowActiveForUser(userId, workflowId, active)`, `listRecentRunsForUser(userId, brandId, limit)`.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-workflow-mutations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateWorkflowSettings } from "@/lib/autopilot/workflow-mutations";

const ok = {
  postsPerPeriod: 1,
  period: "day" as const,
  timezone: "America/Los_Angeles",
  maxAttemptsPerPeriod: 3,
  autoPauseAfterFailedPeriods: 3,
};

describe("validateWorkflowSettings", () => {
  it("accepts a well-formed setting", () => {
    expect(() => validateWorkflowSettings(ok)).not.toThrow();
  });

  it("rejects a rate outside the column's check constraint", () => {
    expect(() => validateWorkflowSettings({ ...ok, postsPerPeriod: 0 })).toThrow(/1 and 10/);
    expect(() => validateWorkflowSettings({ ...ok, postsPerPeriod: 11 })).toThrow(/1 and 10/);
    expect(() => validateWorkflowSettings({ ...ok, postsPerPeriod: 1.5 })).toThrow(/whole number/);
  });

  it("rejects an attempt cap outside the column's check constraint", () => {
    expect(() => validateWorkflowSettings({ ...ok, maxAttemptsPerPeriod: 0 })).toThrow(/1 and 10/);
    expect(() => validateWorkflowSettings({ ...ok, maxAttemptsPerPeriod: 11 })).toThrow(/1 and 10/);
  });

  it("rejects an auto-pause threshold below 1", () => {
    expect(() => validateWorkflowSettings({ ...ok, autoPauseAfterFailedPeriods: 0 })).toThrow(/at least 1/);
  });

  it("rejects a timezone the runtime does not know", () => {
    // Caught here rather than at 3am inside the cron, where an invalid zone
    // would throw on every tick for this workflow and pause it for the wrong
    // reason.
    expect(() => validateWorkflowSettings({ ...ok, timezone: "Mars/Olympus" })).toThrow(/timezone/i);
  });

  it("rejects a period the check constraint would reject", () => {
    expect(() => validateWorkflowSettings({ ...ok, period: "fortnight" as never })).toThrow(/period/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autopilot-workflow-mutations.test.ts`
Expected: FAIL — cannot resolve `@/lib/autopilot/workflow-mutations`.

- [ ] **Step 3: Write the implementation**

Create `lib/autopilot/workflow-mutations.ts`:

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { AutopilotPeriod, AutopilotRun, AutopilotWorkflow, Category } from "@/lib/types";

// Same rule as lib/overlay-mutations.ts: these take the tenant's userId and do
// NOT authenticate, so they must never be exported from a "use server" file —
// every export there is a publicly POST-reachable endpoint. The thin actions in
// app/(app)/autopilot/actions.ts call requireUser() and delegate here.

export interface WorkflowSettings {
  postsPerPeriod: number;
  period: AutopilotPeriod;
  timezone: string;
  maxAttemptsPerPeriod: number;
  autoPauseAfterFailedPeriods: number;
}

// Mirrors migration 0024's check constraints. Validating here turns a
// constraint violation into a readable message in the UI, and — for the
// timezone, which has no DB constraint — stops an unknown zone from throwing
// inside the cron on every tick at 3am.
export function validateWorkflowSettings(s: WorkflowSettings): void {
  if (!Number.isInteger(s.postsPerPeriod)) throw new Error("posts per period must be a whole number");
  if (s.postsPerPeriod < 1 || s.postsPerPeriod > 10) {
    throw new Error("posts per period must be between 1 and 10");
  }
  if (s.period !== "day" && s.period !== "week") throw new Error("period must be 'day' or 'week'");
  if (!Number.isInteger(s.maxAttemptsPerPeriod)) throw new Error("attempt cap must be a whole number");
  if (s.maxAttemptsPerPeriod < 1 || s.maxAttemptsPerPeriod > 10) {
    throw new Error("attempt cap must be between 1 and 10");
  }
  if (!Number.isInteger(s.autoPauseAfterFailedPeriods) || s.autoPauseAfterFailedPeriods < 1) {
    throw new Error("auto-pause threshold must be at least 1");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone });
  } catch {
    throw new Error(`unknown timezone "${s.timezone}"`);
  }
}

export async function listWorkflowsForUser(
  userId: string,
  brandId: string,
): Promise<(AutopilotWorkflow & { category: Pick<Category, "id" | "key" | "name" | "active"> })[]> {
  const supabase = createAdminSupabase();
  // Inner join, so a workflow whose category belongs to another brand is not
  // returned at all. The admin client bypasses RLS, so user_id is explicit.
  const { data, error } = await supabase
    .from("autopilot_workflows")
    .select("*, category:categories!inner(id, key, name, active, brand_id)")
    .eq("user_id", userId)
    .eq("categories.brand_id", brandId);
  if (error) throw new Error(error.message);
  return (data ?? []) as (AutopilotWorkflow & {
    category: Pick<Category, "id" | "key" | "name" | "active">;
  })[];
}

export async function upsertWorkflowForUser(
  userId: string,
  categoryId: string,
  settings: WorkflowSettings,
): Promise<void> {
  validateWorkflowSettings(settings);
  const supabase = createAdminSupabase();
  // categoryId arrives from the client and the admin client would happily
  // attach a workflow to another tenant's category. Same re-check, same
  // reasoning as createOverlayForUser.
  const { data: cat } = await supabase
    .from("categories").select("id").eq("id", categoryId).eq("user_id", userId).maybeSingle();
  if (!cat) throw new Error("unknown category");

  // Columns enumerated, never spread — a server action's arguments arrive as
  // JSON with the TypeScript shape erased, and a trailing spread would let a
  // caller-supplied user_id override the ownership established above.
  // Turning a workflow back on clears the pause: re-enabling something that
  // still reads "paused: missed quota" and still carries its failure counter
  // would auto-pause again after a single miss.
  const { error } = await supabase
    .from("autopilot_workflows")
    .upsert(
      {
        user_id: userId,
        category_id: categoryId,
        posts_per_period: settings.postsPerPeriod,
        period: settings.period,
        timezone: settings.timezone,
        max_attempts_per_period: settings.maxAttemptsPerPeriod,
        auto_pause_after_failed_periods: settings.autoPauseAfterFailedPeriods,
        active: true,
        paused_reason: "",
        consecutive_failed_periods: 0,
      },
      { onConflict: "category_id" },
    );
  if (error) throw new Error(error.message);
}

export async function setWorkflowActiveForUser(
  userId: string,
  workflowId: string,
  active: boolean,
): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from("autopilot_workflows")
    .update(
      active
        ? { active: true, paused_reason: "", consecutive_failed_periods: 0 }
        : { active: false, paused_reason: "turned off by hand" },
    )
    .eq("id", workflowId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function listRecentRunsForUser(
  userId: string,
  brandId: string,
  limit = 20,
): Promise<AutopilotRun[]> {
  const supabase = createAdminSupabase();
  const workflows = await listWorkflowsForUser(userId, brandId);
  if (!workflows.length) return [];
  const { data, error } = await supabase
    .from("autopilot_runs")
    .select("*")
    .eq("user_id", userId)
    .in("workflow_id", workflows.map((w) => w.id))
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as AutopilotRun[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autopilot-workflow-mutations.test.ts && npx tsc --noEmit`
Expected: PASS, 6 tests, no type errors.

- [ ] **Step 5: Commit**

```bash
git add lib/autopilot/workflow-mutations.ts tests/autopilot-workflow-mutations.test.ts
git commit -m "feat: autopilot workflow mutation helpers"
```

---

### Task 8: The tick

**Files:**
- Create: `lib/autopilot/tick.ts`
- Test: `tests/autopilot-tick.test.ts`

**Interfaces:**
- Consumes: `periodStart`/`periodStartUtc` (Task 2), `quotaGap`/`settlePeriod` (Task 3), `selectSource`/`IdeaCandidate`/`IDEA_BATCH` (Task 4), `decideAwaitingImages` (Task 5), `scheduleValidatedPost` with a nullable time (Task 6), and the existing `generateIdeas`, `submitGenerations`, `resolveValidSlides`.
- Produces: `runAutopilotTick(now?: Date): Promise<TickSummary>` where `TickSummary = { workflowsExamined: number; runsOpened: number; runsAdvanced: number; errors: string[] }`; `WORKFLOW_TICK_CAP`.

**Context:** This file is glue. Every decision it makes was already tested in Tasks 2–5; what it adds is the database reads those decisions need and the pipeline calls they authorize. Importing `scheduleValidatedPost` from the route module is the established pattern here — `app/api/mcp/route.ts` and `tests/schedule-validated-post.test.ts` both do it.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-tick.test.ts`. It covers the one branch with real consequences that the pure functions cannot cover: a category with no Buffer channel must fail its run instead of attempting a post.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const updates: Record<string, unknown>[] = [];
const scheduleValidatedPost = vi.fn();

// One chainable stub standing in for the whole query builder. Each table's
// terminal read returns the fixture below; every .update() is recorded so the
// test can assert what the tick wrote.
function tableStub(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ["select", "eq", "in", "neq", "gte", "lt", "order", "limit"]) {
    builder[m] = vi.fn(chain);
  }
  builder.update = vi.fn((values: Record<string, unknown>) => {
    updates.push(values);
    return builder;
  });
  builder.insert = vi.fn(() => builder);
  builder.upsert = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => ({ data: rows[0] ?? null, error: null }));
  builder.single = vi.fn(async () => ({ data: rows[0] ?? null, error: null }));
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null, count: rows.length });
  return builder;
}

const RUN = {
  id: "run-1", user_id: "user-1", workflow_id: "wf-1", category_key: "cat1",
  period_start: "2026-08-14", attempt_no: 1, state: "posting", source: "ready_images",
  idea_id: "idea-1", post_group_id: null, error: "", steps: [],
  created_at: "2026-08-14T12:00:00Z", updated_at: "2026-08-14T12:00:00Z",
};

const WORKFLOW = {
  id: "wf-1", user_id: "user-1", category_id: "c-1", posts_per_period: 1,
  period: "day", timezone: "UTC", max_attempts_per_period: 3,
  auto_pause_after_failed_periods: 3, consecutive_failed_periods: 0,
  last_settled_period: "2026-08-14", active: true, paused_reason: "",
  created_at: "2026-08-14T00:00:00Z", updated_at: "2026-08-14T00:00:00Z",
  // No buffer connection configured — the case under test.
  category: {
    id: "c-1", key: "cat1", name: "Cat 1", active: true, brand_id: "b-1",
    buffer_connection_id: null, buffer_channel_id: "", buffer_channel_service: "",
    post_caption: "", slides: [],
  },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from: (table: string) => {
      if (table === "autopilot_workflows") return tableStub([WORKFLOW]);
      if (table === "autopilot_runs") return tableStub([RUN]);
      return tableStub([]);
    },
  }),
}));
vi.mock("@/app/api/posts/create/route", () => ({ scheduleValidatedPost }));
vi.mock("@/lib/athena/generate-ideas", () => ({ generateIdeas: vi.fn() }));
vi.mock("@/lib/athena/submit-generations", () => ({ submitGenerations: vi.fn() }));

import { runAutopilotTick } from "@/lib/autopilot/tick";

describe("runAutopilotTick", () => {
  beforeEach(() => {
    updates.length = 0;
    scheduleValidatedPost.mockReset();
  });

  it("fails the run instead of posting when the category has no Buffer channel", async () => {
    const summary = await runAutopilotTick(new Date("2026-08-14T12:10:00Z"));

    expect(scheduleValidatedPost).not.toHaveBeenCalled();
    expect(summary.workflowsExamined).toBe(1);
    const failed = updates.find((u) => u.state === "failed");
    expect(failed).toBeDefined();
    expect(String(failed!.error)).toMatch(/buffer/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autopilot-tick.test.ts`
Expected: FAIL — cannot resolve `@/lib/autopilot/tick`.

- [ ] **Step 3: Write the implementation**

Create `lib/autopilot/tick.ts`:

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { generateIdeas } from "@/lib/athena/generate-ideas";
import { submitGenerations } from "@/lib/athena/submit-generations";
import { scheduleValidatedPost } from "@/app/api/posts/create/route";
import { resolveValidSlides, type SiblingGeneration } from "@/lib/athena/carousel";
import { periodStart, periodStartUtc } from "@/lib/autopilot/period";
import { quotaGap, settlePeriod } from "@/lib/autopilot/quota";
import { selectSource, IDEA_BATCH, type IdeaCandidate } from "@/lib/autopilot/sourcing";
import { decideAwaitingImages } from "@/lib/autopilot/run-step";
import type {
  AutopilotRun, AutopilotRunStep, AutopilotSource, AutopilotWorkflow, Category, Idea,
} from "@/lib/types";

// How many workflows one tick looks at. At a 5-minute cadence this is far more
// than any single tenant needs, and it bounds the tick's DB work.
export const WORKFLOW_TICK_CAP = 20;
// How many ideas are considered as sourcing candidates per workflow.
const CANDIDATE_LIMIT = 50;

const LIVE_STATES = ["sourcing", "awaiting_images", "posting"];

export interface TickSummary {
  workflowsExamined: number;
  runsOpened: number;
  runsAdvanced: number;
  errors: string[];
}

type WorkflowRow = AutopilotWorkflow & { category: Category | null };

export async function runAutopilotTick(now: Date = new Date()): Promise<TickSummary> {
  const supabase = createAdminSupabase();
  const summary: TickSummary = {
    workflowsExamined: 0, runsOpened: 0, runsAdvanced: 0, errors: [],
  };

  const { data, error } = await supabase
    .from("autopilot_workflows")
    .select("*, category:categories(*)")
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(WORKFLOW_TICK_CAP);
  if (error) throw new Error(`workflow query failed: ${error.message}`);

  // One idea-generation call per tick, app-wide (spec §5): it makes two
  // Anthropic calls and can take ~90s of this route's 120s budget. Whoever
  // takes the slot moves to awaiting_images and stops competing for it, so
  // deferred workflows win it on later ticks without any explicit fairness
  // bookkeeping.
  const budget = { ideaGenerations: 1 };

  for (const row of (data ?? []) as WorkflowRow[]) {
    const { category, ...workflow } = row;
    if (!category?.active) continue;
    summary.workflowsExamined++;
    try {
      await tickWorkflow(supabase, workflow, category, now, budget, summary);
    } catch (e) {
      // One tenant's broken workflow must never stop the sweep.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`autopilot: workflow ${workflow.id} failed:`, message);
      summary.errors.push(`${workflow.id.slice(0, 8)}: ${message}`);
    }
  }
  return summary;
}

async function tickWorkflow(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  now: Date,
  budget: { ideaGenerations: number },
  summary: TickSummary,
): Promise<void> {
  const period = periodStart(now, workflow.timezone, workflow.period);

  // 1. Settle the period that just ended, exactly once per rollover.
  if (workflow.last_settled_period !== period) {
    const priorLanded = workflow.last_settled_period
      ? await countLandedGroups(
          supabase, workflow, category.key, workflow.last_settled_period, period,
        )
      : 0;
    const decision = settlePeriod({
      lastSettledPeriod: workflow.last_settled_period,
      currentPeriod: period,
      priorLandedGroups: priorLanded,
      postsPerPeriod: workflow.posts_per_period,
      consecutiveFailedPeriods: workflow.consecutive_failed_periods,
      autoPauseAfterFailedPeriods: workflow.auto_pause_after_failed_periods,
      lastError: await lastErrorForPeriod(supabase, workflow.id, workflow.last_settled_period),
    });
    if (decision.action === "settle") {
      const { error } = await supabase
        .from("autopilot_workflows")
        .update({
          consecutive_failed_periods: decision.consecutiveFailedPeriods,
          active: decision.active,
          paused_reason: decision.pausedReason,
          last_settled_period: decision.lastSettledPeriod,
        })
        .eq("id", workflow.id)
        .eq("user_id", workflow.user_id);
      if (error) throw new Error(`settle failed: ${error.message}`);
      if (!decision.active) return;
    }
  }

  // 2. A live run gets advanced; a workflow never has two at once.
  const { data: liveData, error: liveErr } = await supabase
    .from("autopilot_runs")
    .select("*")
    .eq("workflow_id", workflow.id)
    .eq("user_id", workflow.user_id)
    .in("state", LIVE_STATES)
    .order("created_at", { ascending: true })
    .limit(1);
  if (liveErr) throw new Error(`live-run query failed: ${liveErr.message}`);
  const live = ((liveData ?? []) as AutopilotRun[])[0];
  if (live) {
    await advanceRun(supabase, workflow, category, live, now, budget);
    summary.runsAdvanced++;
    return;
  }

  // 3. Measure the gap for the open period.
  const landed = await countLandedGroups(supabase, workflow, category.key, period);
  const { count, error: countErr } = await supabase
    .from("autopilot_runs")
    .select("*", { count: "exact", head: true })
    .eq("workflow_id", workflow.id)
    .eq("period_start", period);
  if (countErr) throw new Error(`attempt count failed: ${countErr.message}`);
  const gap = quotaGap({
    landedGroups: landed,
    postsPerPeriod: workflow.posts_per_period,
    attemptsUsed: count ?? 0,
    maxAttempts: workflow.max_attempts_per_period,
  });
  if (gap.action !== "open") return;

  // 4. Open the attempt and advance it now, rather than idling until the next
  // tick — the whole point of a 5-minute cadence is that a run makes progress
  // the moment it exists.
  const { data: created, error: insErr } = await supabase
    .from("autopilot_runs")
    .insert({
      user_id: workflow.user_id,
      workflow_id: workflow.id,
      category_key: category.key,
      period_start: period,
      attempt_no: gap.attemptNo,
      state: "sourcing",
    })
    .select()
    .single();
  if (insErr) {
    // unique (workflow_id, period_start, attempt_no) — an overlapping tick
    // already opened this attempt and is advancing it. Leave it alone.
    if ((insErr as { code?: string }).code === "23505") return;
    throw new Error(`run insert failed: ${insErr.message}`);
  }
  summary.runsOpened++;
  await advanceRun(supabase, workflow, category, created as AutopilotRun, now, budget);
}

// Distinct non-failed post GROUPS for this category in [period, until).
// Groups, not rows: a multi-channel post is several rows of one publication.
// `until` is mandatory when counting a period that has ended — without it,
// today's posts would count toward yesterday's quota and hide a real miss.
async function countLandedGroups(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  categoryKey: string,
  period: string,
  until?: string,
): Promise<number> {
  let query = supabase
    .from("posts")
    .select("post_group_id")
    .eq("user_id", workflow.user_id)
    .eq("category_key", categoryKey)
    .neq("status", "failed")
    .gte("created_at", periodStartUtc(period, workflow.timezone).toISOString());
  if (until) {
    query = query.lt("created_at", periodStartUtc(until, workflow.timezone).toISOString());
  }
  const { data, error } = await query;
  if (error) throw new Error(`landed-post query failed: ${error.message}`);
  return new Set((data ?? []).map((r) => (r as { post_group_id: string }).post_group_id)).size;
}

async function lastErrorForPeriod(
  supabase: SupabaseClient,
  workflowId: string,
  period: string | null,
): Promise<string> {
  if (!period) return "";
  const { data } = await supabase
    .from("autopilot_runs")
    .select("error")
    .eq("workflow_id", workflowId)
    .eq("period_start", period)
    .eq("state", "failed")
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? [])[0] as { error: string } | undefined)?.error ?? "";
}

async function advanceRun(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  run: AutopilotRun,
  now: Date,
  budget: { ideaGenerations: number },
): Promise<void> {
  if (run.state === "sourcing") {
    const next = await stepSourcing(supabase, workflow, category, run, budget);
    // The only chained transition allowed in one tick: material that is
    // already on the shelf should not wait five minutes to go out. Every
    // other step ends the tick for this workflow.
    if (next) await stepPosting(supabase, workflow, category, next);
    return;
  }
  if (run.state === "awaiting_images") {
    await stepAwaitingImages(supabase, workflow, category, run, now);
    return;
  }
  if (run.state === "posting") {
    await stepPosting(supabase, workflow, category, run);
  }
}

// Returns the run to post immediately, or null when this tick is done with it.
async function stepSourcing(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  run: AutopilotRun,
  budget: { ideaGenerations: number },
): Promise<AutopilotRun | null> {
  const candidates = await loadCandidates(supabase, workflow.user_id, category.key);
  const priorAttempt = await loadPriorAttempt(supabase, run);
  const decision = selectSource({
    candidates,
    priorAttempt,
    ideaGenerationAvailable: budget.ideaGenerations > 0,
  });

  if (decision.action === "defer") {
    // Leave the run in `sourcing`; the next tick tries again. Nothing was
    // spent, so this does not consume the attempt.
    await patchRun(supabase, run, { steps: appendStep(run, "defer", decision.reason) });
    return null;
  }

  if (decision.action === "post") {
    const patched = await patchRun(supabase, run, {
      state: "posting",
      source: decision.source,
      idea_id: decision.ideaId,
      post_group_id: decision.postGroupId,
      steps: appendStep(run, "source", `${decision.source} → idea ${decision.ideaId.slice(0, 8)}`),
    });
    return patched;
  }

  if (decision.action === "submit_images") {
    await submitGenerations(workflow.user_id, [decision.ideaId]);
    await patchRun(supabase, run, {
      state: "awaiting_images",
      source: decision.source,
      idea_id: decision.ideaId,
      steps: appendStep(run, "submit", `approved idea ${decision.ideaId.slice(0, 8)}`),
    });
    return null;
  }

  // Tier 4 — write new material. The slot is taken before the call, so a
  // throw cannot hand it to another workflow in the same tick.
  budget.ideaGenerations--;
  const result = await generateIdeas(
    workflow.user_id, category.brand_id, category.key, IDEA_BATCH,
  );
  if (!result.inserted) {
    await failRun(
      supabase, run,
      `idea generation kept nothing (${result.filteredOut} filtered out)`,
    );
    return null;
  }

  // Approve exactly one of the new batch; the rest stay at pending_review as
  // inventory. Ordered by id for a deterministic, re-runnable choice.
  const { data: fresh, error: freshErr } = await supabase
    .from("ideas")
    .select("id")
    .eq("user_id", workflow.user_id)
    .eq("batch_id", result.batchId)
    .eq("category_key", category.key)
    .order("id", { ascending: true })
    .limit(1);
  if (freshErr) throw new Error(`new-idea query failed: ${freshErr.message}`);
  const chosen = ((fresh ?? [])[0] as { id: string } | undefined)?.id;
  if (!chosen) {
    await failRun(supabase, run, "idea generation reported inserts but none were readable");
    return null;
  }

  const { error: apprErr } = await supabase
    .from("ideas")
    .update({ approved: true, status: "approved" })
    .eq("id", chosen)
    .eq("user_id", workflow.user_id);
  if (apprErr) throw new Error(`auto-approve failed: ${apprErr.message}`);

  await submitGenerations(workflow.user_id, [chosen]);
  await patchRun(supabase, run, {
    state: "awaiting_images",
    source: decision.source,
    idea_id: chosen,
    steps: appendStep(
      run, "generate",
      `${result.inserted} ideas kept, approved ${chosen.slice(0, 8)}, submitted anchor`,
    ),
  });
  return null;
}

async function stepAwaitingImages(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  run: AutopilotRun,
  now: Date,
): Promise<void> {
  if (!run.idea_id) {
    await failRun(supabase, run, "run reached awaiting_images with no idea");
    return;
  }
  const state = await loadIdeaState(supabase, workflow.user_id, run.idea_id);
  if (!state) {
    await failRun(supabase, run, "the run's idea no longer exists");
    return;
  }
  const decision = decideAwaitingImages({
    slideCount: state.slideCount,
    readySlideIndexes: state.readySlideIndexes,
    hasInFlightGeneration: state.hasInFlightGeneration,
    runCreatedAt: run.created_at,
    now,
  });
  if (decision.action === "wait") return;
  if (decision.action === "fail") {
    await failRun(supabase, run, decision.error);
    return;
  }
  const patched = await patchRun(supabase, run, {
    state: "posting",
    steps: appendStep(run, "images", `all ${state.slideCount} slides ready`),
  });
  await stepPosting(supabase, workflow, category, patched);
}

async function stepPosting(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  run: AutopilotRun,
): Promise<void> {
  if (!run.idea_id) {
    await failRun(supabase, run, "run reached posting with no idea");
    return;
  }
  // Checked before anything is attempted: a category with no channel can
  // never post, and saying so plainly beats a Buffer error nobody can act on.
  if (!category.buffer_connection_id || !category.buffer_channel_id) {
    await failRun(
      supabase, run,
      `category "${category.key}" has no Buffer channel configured — set one in Config`,
    );
    return;
  }

  const state = await loadIdeaState(supabase, workflow.user_id, run.idea_id);
  if (!state) {
    await failRun(supabase, run, "the run's idea no longer exists");
    return;
  }
  const generationIds = state.orderedGenerationIds;
  if (generationIds.length !== state.slideCount) {
    await failRun(supabase, run, "carousel stopped being complete before it could post");
    return;
  }

  const caption = state.postText || category.post_caption || "";
  const { postGroupId, results, allFailed } = await scheduleValidatedPost(workflow.user_id, {
    categoryKey: category.key,
    generationIds,
    channels: [{
      connectionId: category.buffer_connection_id,
      channelId: category.buffer_channel_id,
      service: category.buffer_channel_service,
      caption,
    }],
    caption,
    // null → Buffer's own queue decides the publish time (spec §2).
    scheduledAt: null,
    postGroupId: run.post_group_id,
  });

  const failures = results.filter((r) => r.status === "failed");
  if (allFailed) {
    // post_group_id is recorded even on failure: the next attempt's tier-1
    // sourcing reuses it so the retry replaces these failed rows rather than
    // stacking new ones beside them.
    await patchRun(supabase, run, {
      state: "failed",
      post_group_id: postGroupId,
      error: failures.map((f) => f.error).join("; ") || "every channel failed",
      steps: appendStep(run, "post", "every channel failed"),
    });
    return;
  }

  // Partial multi-channel success counts as landed and is NOT auto-retried:
  // per-channel retry is safe mechanically, but the cost of getting it wrong
  // is a duplicate live post, so that stays a human decision in the composer.
  await patchRun(supabase, run, {
    state: "succeeded",
    post_group_id: postGroupId,
    error: failures.length ? `partial: ${failures.map((f) => f.error).join("; ")}` : "",
    steps: appendStep(
      run, "post",
      `${results.length - failures.length} of ${results.length} channels queued`,
    ),
  });
}

interface IdeaState {
  slideCount: number;
  readySlideIndexes: number[];
  orderedGenerationIds: string[];
  hasInFlightGeneration: boolean;
  postText: string;
}

async function loadIdeaState(
  supabase: SupabaseClient,
  userId: string,
  ideaId: string,
): Promise<IdeaState | null> {
  const { data: ideaRow } = await supabase
    .from("ideas").select("id, slides, post_text")
    .eq("id", ideaId).eq("user_id", userId).maybeSingle();
  if (!ideaRow) return null;
  const idea = ideaRow as Pick<Idea, "id" | "slides" | "post_text">;
  const slideCount = (idea.slides ?? []).length || 1;

  const { data: genRows, error } = await supabase
    .from("generations")
    .select("id, idea_id, slide_index, anchor_generation_id, status, created_at")
    .eq("idea_id", ideaId).eq("user_id", userId);
  if (error) throw new Error(`generation query failed: ${error.message}`);
  const siblings = (genRows ?? []) as (SiblingGeneration & { status: string })[];

  const resolved = resolveValidSlides(slideCount, siblings);
  return {
    slideCount,
    readySlideIndexes: resolved.filter((s) => s.generationId).map((s) => s.slideIndex),
    orderedGenerationIds: resolved
      .filter((s) => s.generationId)
      .map((s) => s.generationId as string),
    hasInFlightGeneration: siblings.some(
      (g) => g.status === "submitted" || g.status === "polling",
    ),
    postText: idea.post_text ?? "",
  };
}

async function loadCandidates(
  supabase: SupabaseClient,
  userId: string,
  categoryKey: string,
): Promise<IdeaCandidate[]> {
  const { data: ideaRows, error: ideaErr } = await supabase
    .from("ideas")
    .select("id, status, slides, created_at")
    .eq("user_id", userId)
    .eq("category_key", categoryKey)
    .in("status", ["approved", "generated"])
    .order("created_at", { ascending: true })
    .limit(CANDIDATE_LIMIT);
  if (ideaErr) throw new Error(`candidate query failed: ${ideaErr.message}`);
  const ideas = (ideaRows ?? []) as Pick<Idea, "id" | "status" | "slides" | "created_at">[];
  if (!ideas.length) return [];
  const ideaIds = ideas.map((i) => i.id);

  const { data: genRows, error: genErr } = await supabase
    .from("generations")
    .select("id, idea_id, slide_index, anchor_generation_id, status, created_at")
    .in("idea_id", ideaIds)
    .eq("user_id", userId);
  if (genErr) throw new Error(`candidate generation query failed: ${genErr.message}`);
  const gens = (genRows ?? []) as (SiblingGeneration & { idea_id: string; status: string })[];

  // Resolved through post_images, not posts.idea_id: a freeform post spanning
  // several ideas carries idea_id: null, so keying off it would forget that
  // this idea's slides already went out inside someone else's post.
  const postedGenIds = new Set<string>();
  if (gens.length) {
    const { data: postedRows, error: postedErr } = await supabase
      .from("post_images")
      .select("generation_id, post:posts(status)")
      .in("generation_id", gens.map((g) => g.id))
      .eq("user_id", userId);
    if (postedErr) throw new Error(`posted-slide query failed: ${postedErr.message}`);
    for (const row of (postedRows ?? []) as unknown as {
      generation_id: string; post: { status: string } | null;
    }[]) {
      if (row.post && row.post.status !== "failed") postedGenIds.add(row.generation_id);
    }
  }

  const { data: claimRows, error: claimErr } = await supabase
    .from("autopilot_runs")
    .select("idea_id")
    .eq("user_id", userId)
    .in("state", LIVE_STATES)
    .in("idea_id", ideaIds);
  if (claimErr) throw new Error(`claim query failed: ${claimErr.message}`);
  const claimed = new Set(
    ((claimRows ?? []) as { idea_id: string | null }[]).map((r) => r.idea_id).filter(Boolean),
  );

  return ideas.map((idea) => {
    const siblings = gens.filter((g) => g.idea_id === idea.id);
    const slideCount = (idea.slides ?? []).length || 1;
    const resolved = resolveValidSlides(slideCount, siblings);
    return {
      ideaId: idea.id,
      status: idea.status,
      slideCount,
      readySlideIndexes: resolved.filter((s) => s.generationId).map((s) => s.slideIndex),
      hasNonFailedPost: siblings.some((g) => postedGenIds.has(g.id)),
      hasInFlightGeneration: siblings.some(
        (g) => g.status === "submitted" || g.status === "polling",
      ),
      claimedByLiveRun: claimed.has(idea.id),
      createdAt: idea.created_at,
    };
  });
}

// The most recent earlier attempt in this run's own period — tier 1's input.
async function loadPriorAttempt(
  supabase: SupabaseClient,
  run: AutopilotRun,
): Promise<{ ideaId: string; postGroupId: string | null } | null> {
  const { data } = await supabase
    .from("autopilot_runs")
    .select("idea_id, post_group_id")
    .eq("workflow_id", run.workflow_id)
    .eq("period_start", run.period_start)
    .eq("state", "failed")
    .order("created_at", { ascending: false })
    .limit(1);
  const prior = ((data ?? [])[0] ?? null) as
    | { idea_id: string | null; post_group_id: string | null }
    | null;
  if (!prior?.idea_id) return null;
  return { ideaId: prior.idea_id, postGroupId: prior.post_group_id };
}

function appendStep(run: AutopilotRun, step: string, detail: string): AutopilotRunStep[] {
  return [...(run.steps ?? []), { at: new Date().toISOString(), step, detail }];
}

async function patchRun(
  supabase: SupabaseClient,
  run: AutopilotRun,
  values: Partial<
    Pick<AutopilotRun, "state" | "error" | "idea_id" | "post_group_id" | "steps">
  > & { source?: AutopilotSource },
): Promise<AutopilotRun> {
  const { error } = await supabase
    .from("autopilot_runs")
    .update(values)
    .eq("id", run.id)
    .eq("user_id", run.user_id);
  if (error) throw new Error(`run update failed: ${error.message}`);
  return { ...run, ...values } as AutopilotRun;
}

async function failRun(
  supabase: SupabaseClient,
  run: AutopilotRun,
  message: string,
): Promise<void> {
  console.error(`autopilot: run ${run.id} failed: ${message}`);
  await patchRun(supabase, run, {
    state: "failed",
    error: message,
    steps: appendStep(run, "fail", message),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autopilot-tick.test.ts && npx tsc --noEmit`
Expected: PASS, 1 test, no type errors. Then run the whole suite: `npm test` — everything still passes.

- [ ] **Step 5: Commit**

```bash
git add lib/autopilot/tick.ts tests/autopilot-tick.test.ts
git commit -m "feat: autopilot tick orchestration"
```

---

### Task 9: The cron route and its deploy step

**Files:**
- Create: `app/api/jobs/autopilot/route.ts`
- Create: `docs/autopilot-cron-setup.md`
- Test: `tests/autopilot-route.test.ts`

**Interfaces:**
- Consumes: `runAutopilotTick` (Task 8).
- Produces: `GET /api/jobs/autopilot`.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runAutopilotTick = vi.fn(async () => ({
  workflowsExamined: 0, runsOpened: 0, runsAdvanced: 0, errors: [] as string[],
}));
vi.mock("@/lib/autopilot/tick", () => ({ runAutopilotTick }));

import { GET } from "@/app/api/jobs/autopilot/route";

function request(auth?: string): Request {
  return new Request("https://example.com/api/jobs/autopilot", {
    headers: auth ? { authorization: auth } : {},
  });
}

describe("GET /api/jobs/autopilot", () => {
  beforeEach(() => {
    runAutopilotTick.mockClear();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects a request with no bearer token", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(request() as any);
    expect(res.status).toBe(401);
    expect(runAutopilotTick).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(request("Bearer wrong") as any);
    expect(res.status).toBe(401);
    expect(runAutopilotTick).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(request("Bearer s3cret") as any);
    expect(res.status).toBe(401);
    expect(runAutopilotTick).not.toHaveBeenCalled();
  });

  it("runs a tick for the right token and returns its summary", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(request("Bearer s3cret") as any);
    expect(res.status).toBe(200);
    expect(runAutopilotTick).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ workflowsExamined: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autopilot-route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/jobs/autopilot/route`.

- [ ] **Step 3: Write the route**

Create `app/api/jobs/autopilot/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { runAutopilotTick } from "@/lib/autopilot/tick";

export const maxDuration = 120;

// Same shape as app/api/jobs/poll/route.ts: constant-time comparison, and
// fail closed when CRON_SECRET is unset. A cron request carries no session,
// so requireUser() is never an option here.
function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

// Deliberately NOT folded into /api/jobs/poll: that job runs every 60s and
// spends its 120s budget on image ingestion, and a ~90s idea-generation call
// inside it would starve the work carousels depend on.
export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await runAutopilotTick();
    return NextResponse.json(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("autopilot tick failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autopilot-route.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the deploy note**

Create `docs/autopilot-cron-setup.md`:

```markdown
# Autopilot cron setup

Autopilot needs one cron job, registered once by the operator. Tenants
configure nothing — a single tick sweeps every tenant's workflows.

At cron-job.org, alongside the existing `/api/jobs/poll` job:

- **URL:** `https://<your-domain>/api/jobs/autopilot`
- **Method:** GET
- **Schedule:** every 5 minutes
- **Header:** `Authorization: Bearer <CRON_SECRET>` — the same secret the poll
  job uses, read from the `CRON_SECRET` environment variable.

The route fails closed: with `CRON_SECRET` unset it returns 401 to everyone,
so a misconfigured deploy silently does nothing rather than running unguarded.

Why 5 minutes and not 60 seconds like the poll job: a tick may spend ~90s
generating ideas, and nothing autopilot does is latency-sensitive — a daily
quota has all day. Why a separate job at all: the poll job's 120s budget is
already committed to image ingestion.

A healthy response is `{"workflowsExamined":N,"runsOpened":…,"runsAdvanced":…,"errors":[]}`.
Entries in `errors` are per-workflow failures that did not stop the sweep.
```

- [ ] **Step 6: Commit**

```bash
git add app/api/jobs/autopilot/route.ts tests/autopilot-route.test.ts docs/autopilot-cron-setup.md
git commit -m "feat: autopilot cron route"
```

---

### Task 10: The `/autopilot` page

**Files:**
- Create: `app/(app)/autopilot/page.tsx`
- Create: `app/(app)/autopilot/actions.ts`
- Create: `app/(app)/autopilot/workflow-row.tsx`
- Modify: `app/(app)/nav-links.tsx`
- Test: `tests/autopilot-status.test.ts`
- Create: `lib/autopilot/status.ts`

**Interfaces:**
- Consumes: `listWorkflowsForUser`, `upsertWorkflowForUser`, `setWorkflowActiveForUser`, `listRecentRunsForUser` (Task 7); `AutopilotRun`, `AutopilotWorkflow` (Task 1).
- Produces: `describeWorkflowStatus(input): { tone: "on" | "done" | "working" | "paused" | "off"; label: string }` and the page.

**Context:** Read `app/(app)/schedule/page.tsx` for the server-component + `createServerSupabase` pattern, `app/(app)/ideas/actions.ts` for the `"use server"` delegation pattern, and `lib/auth/active-brand.ts` for how the active brand is resolved.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { describeWorkflowStatus } from "@/lib/autopilot/status";

const base = {
  active: true,
  pausedReason: "",
  postsPerPeriod: 1,
  landedGroups: 0,
  attemptsUsed: 0,
  maxAttempts: 3,
  liveState: null as string | null,
};

describe("describeWorkflowStatus", () => {
  it("reports a met quota", () => {
    const s = describeWorkflowStatus({ ...base, landedGroups: 1 });
    expect(s.tone).toBe("done");
    expect(s.label).toBe("posted 1/1");
  });

  it("names the step a live run is on, with its attempt number", () => {
    const s = describeWorkflowStatus({
      ...base, liveState: "awaiting_images", attemptsUsed: 2,
    });
    expect(s.tone).toBe("working");
    expect(s.label).toBe("attempt 2 of 3 — generating images");
  });

  it("says it is waiting when no run is live and attempts remain", () => {
    const s = describeWorkflowStatus(base);
    expect(s.tone).toBe("on");
    expect(s.label).toBe("waiting to start (0/1 posted)");
  });

  it("says the attempts ran out rather than pretending it is still working", () => {
    const s = describeWorkflowStatus({ ...base, attemptsUsed: 3 });
    expect(s.tone).toBe("paused");
    expect(s.label).toBe("gave up for this period (3 of 3 attempts used)");
  });

  it("surfaces the pause reason verbatim", () => {
    const s = describeWorkflowStatus({
      ...base, active: false, pausedReason: "missed quota 3 periods running",
    });
    expect(s.tone).toBe("off");
    expect(s.label).toBe("paused: missed quota 3 periods running");
  });

  it("says plainly that it is off when it was turned off with no reason", () => {
    const s = describeWorkflowStatus({ ...base, active: false });
    expect(s).toEqual({ tone: "off", label: "off" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autopilot-status.test.ts`
Expected: FAIL — cannot resolve `@/lib/autopilot/status`.

- [ ] **Step 3: Write the status helper**

Create `lib/autopilot/status.ts`:

```ts
export interface StatusInput {
  active: boolean;
  pausedReason: string;
  postsPerPeriod: number;
  landedGroups: number;
  attemptsUsed: number;
  maxAttempts: number;
  liveState: string | null;
}

export interface WorkflowStatus {
  tone: "on" | "done" | "working" | "paused" | "off";
  label: string;
}

const STEP_WORDS: Record<string, string> = {
  sourcing: "choosing material",
  awaiting_images: "generating images",
  posting: "posting",
};

// One sentence for the whole state of a workflow. Order matters: off beats
// everything (a paused workflow is doing nothing regardless of its counts),
// then a met quota, then live work, then the attempt cap.
export function describeWorkflowStatus(input: StatusInput): WorkflowStatus {
  if (!input.active) {
    return { tone: "off", label: input.pausedReason ? `paused: ${input.pausedReason}` : "off" };
  }
  if (input.landedGroups >= input.postsPerPeriod) {
    return { tone: "done", label: `posted ${input.landedGroups}/${input.postsPerPeriod}` };
  }
  if (input.liveState) {
    const step = STEP_WORDS[input.liveState] ?? input.liveState;
    return {
      tone: "working",
      label: `attempt ${input.attemptsUsed} of ${input.maxAttempts} — ${step}`,
    };
  }
  if (input.attemptsUsed >= input.maxAttempts) {
    return {
      tone: "paused",
      label: `gave up for this period (${input.attemptsUsed} of ${input.maxAttempts} attempts used)`,
    };
  }
  return {
    tone: "on",
    label: `waiting to start (${input.landedGroups}/${input.postsPerPeriod} posted)`,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autopilot-status.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the server actions**

Create `app/(app)/autopilot/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import {
  upsertWorkflowForUser, setWorkflowActiveForUser, type WorkflowSettings,
} from "@/lib/autopilot/workflow-mutations";

// Every export of a "use server" file is a public endpoint reachable by direct
// POST, so each action authenticates first and then delegates to the
// userId-parameterized core in lib/autopilot/workflow-mutations.ts — which
// deliberately does not live here.

export async function saveWorkflow(categoryId: string, settings: WorkflowSettings) {
  const user = await requireUser();
  await upsertWorkflowForUser(user.id, categoryId, settings);
  revalidatePath("/autopilot");
}

export async function setWorkflowActive(workflowId: string, active: boolean) {
  const user = await requireUser();
  await setWorkflowActiveForUser(user.id, workflowId, active);
  revalidatePath("/autopilot");
}

// "Turn on for every category" — the bulk action that makes setting up five
// categories one click instead of five. Each category is upserted with the
// same defaults; an existing workflow keeps its own rate only if the caller
// passes its current settings, so the UI sends per-category settings rather
// than assuming.
export async function saveWorkflows(
  entries: { categoryId: string; settings: WorkflowSettings }[],
) {
  const user = await requireUser();
  for (const e of entries) {
    await upsertWorkflowForUser(user.id, e.categoryId, e.settings);
  }
  revalidatePath("/autopilot");
}
```

- [ ] **Step 6: Write the page and row component**

Create `app/(app)/autopilot/workflow-row.tsx`:

```tsx
"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { saveWorkflow, setWorkflowActive } from "./actions";
import type { WorkflowStatus } from "@/lib/autopilot/status";

const TONE_VARIANT: Record<WorkflowStatus["tone"], "default" | "secondary" | "outline" | "destructive"> = {
  on: "outline", done: "default", working: "secondary", paused: "destructive", off: "outline",
};

export interface RowProps {
  categoryId: string;
  categoryName: string;
  workflowId: string | null;
  active: boolean;
  postsPerPeriod: number;
  period: "day" | "week";
  timezone: string;
  status: WorkflowStatus;
}

export function WorkflowRow(props: RowProps) {
  const [pending, start] = useTransition();

  function toggle() {
    start(async () => {
      try {
        if (!props.workflowId) {
          await saveWorkflow(props.categoryId, {
            postsPerPeriod: 1, period: "day",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            maxAttemptsPerPeriod: 3, autoPauseAfterFailedPeriods: 3,
          });
          toast.success(`Autopilot on for ${props.categoryName}`);
          return;
        }
        await setWorkflowActive(props.workflowId, !props.active);
        toast.success(props.active ? "Turned off" : "Turned on");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save");
      }
    });
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border p-3">
      <span className="truncate text-sm font-medium">{props.categoryName}</span>
      <span className="text-xs text-muted-foreground">
        {props.workflowId
          ? `${props.postsPerPeriod}× per ${props.period} · ${props.timezone}`
          : "not set up"}
      </span>
      <Badge variant={TONE_VARIANT[props.status.tone]} className="ml-auto shrink-0">
        {props.status.label}
      </Badge>
      <Button size="sm" variant="outline" onClick={toggle} disabled={pending}>
        {props.workflowId && props.active ? "Turn off" : "Turn on"}
      </Button>
    </div>
  );
}
```

Create `app/(app)/autopilot/page.tsx`:

```tsx
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { createServerSupabase } from "@/lib/supabase/server";
import { listWorkflowsForUser, listRecentRunsForUser } from "@/lib/autopilot/workflow-mutations";
import { describeWorkflowStatus } from "@/lib/autopilot/status";
import { periodStart, periodStartUtc } from "@/lib/autopilot/period";
import { WorkflowRow } from "./workflow-row";
import { Badge } from "@/components/ui/badge";
import type { AutopilotRun } from "@/lib/types";

export const dynamic = "force-dynamic";

const LIVE_STATES = ["sourcing", "awaiting_images", "posting"];

export default async function AutopilotPage() {
  const user = await requireUser();
  // requireActiveBrand, not getActiveBrand: it redirects to /onboarding when
  // there is no brand, which is what every other page here does.
  const brand = await requireActiveBrand(user.id);

  const supabase = await createServerSupabase();
  const { data: catData } = await supabase
    .from("categories").select("id, key, name")
    .eq("brand_id", brand.id).eq("active", true).order("name");
  const categories = (catData ?? []) as { id: string; key: string; name: string }[];

  const workflows = await listWorkflowsForUser(user.id, brand.id);
  const byCategory = new Map(workflows.map((w) => [w.category_id, w]));
  const runs = await listRecentRunsForUser(user.id, brand.id, 20);
  const now = new Date();

  const rows = await Promise.all(categories.map(async (c) => {
    const wf = byCategory.get(c.id);
    if (!wf) {
      return {
        categoryId: c.id, categoryName: c.name, workflowId: null, active: false,
        postsPerPeriod: 1, period: "day" as const, timezone: "", 
        status: describeWorkflowStatus({
          active: false, pausedReason: "", postsPerPeriod: 1, landedGroups: 0,
          attemptsUsed: 0, maxAttempts: 3, liveState: null,
        }),
      };
    }
    const period = periodStart(now, wf.timezone, wf.period);
    const from = periodStartUtc(period, wf.timezone).toISOString();
    const { data: postRows } = await supabase
      .from("posts").select("post_group_id")
      .eq("category_key", c.key).neq("status", "failed").gte("created_at", from);
    const landed = new Set((postRows ?? []).map((r) => (r as { post_group_id: string }).post_group_id)).size;
    const periodRuns = runs.filter((r) => r.workflow_id === wf.id && r.period_start === period);
    return {
      categoryId: c.id, categoryName: c.name, workflowId: wf.id, active: wf.active,
      postsPerPeriod: wf.posts_per_period, period: wf.period, timezone: wf.timezone,
      status: describeWorkflowStatus({
        active: wf.active, pausedReason: wf.paused_reason,
        postsPerPeriod: wf.posts_per_period, landedGroups: landed,
        attemptsUsed: periodRuns.length, maxAttempts: wf.max_attempts_per_period,
        liveState: periodRuns.find((r) => LIVE_STATES.includes(r.state))?.state ?? null,
      }),
    };
  }));

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-lg font-semibold">Autopilot</h1>
        <p className="text-sm text-muted-foreground">
          A category on autopilot publishes on its own — ideas, images, and the post.
          Timing is Buffer&apos;s queue, not this page.
        </p>
        <div className="space-y-2">
          {rows.map((r) => <WorkflowRow key={r.categoryId} {...r} />)}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Recent runs</h2>
        {runs.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing has run yet.</p>
        )}
        {runs.map((run: AutopilotRun) => (
          <div key={run.id} className="flex items-center gap-3 rounded-xl border p-3 text-sm">
            <span className="shrink-0 text-xs text-muted-foreground">
              {run.period_start} · attempt {run.attempt_no}
            </span>
            <span className="truncate">{run.category_key}</span>
            {run.source && <Badge variant="outline">{run.source.replace("_", " ")}</Badge>}
            <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
              {run.error || run.state}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 7: Add the nav entry**

In `app/(app)/nav-links.tsx`, add `Bot` to the lucide import and insert the entry after `Schedule`:

```tsx
import { Lightbulb, Sparkles, Images, Send, CalendarDays, Bot, Settings } from "lucide-react";

const nav = [
  { href: "/ideas", label: "Ideas", icon: Lightbulb },
  { href: "/generate", label: "Generate", icon: Sparkles },
  { href: "/gallery", label: "Gallery", icon: Images },
  { href: "/post", label: "Post", icon: Send },
  { href: "/schedule", label: "Schedule", icon: CalendarDays },
  { href: "/autopilot", label: "Autopilot", icon: Bot },
  { href: "/config", label: "Config", icon: Settings },
];
```

- [ ] **Step 8: Verify the build and the suite**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all tests pass, no type errors, no lint errors, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add "app/(app)/autopilot" "app/(app)/nav-links.tsx" lib/autopilot/status.ts tests/autopilot-status.test.ts
git commit -m "feat: autopilot page"
```

---

### Task 11: Apply the migration and verify live

**Files:**
- Modify: none (deploy task)

**Interfaces:**
- Consumes: everything above.
- Produces: a working autopilot in production.

**Context:** Migrations in this project are applied by hand against Supabase. Migration `0023` was still unapplied as of the last project note — check whether it needs applying before `0024`.

- [ ] **Step 1: Check for unapplied migrations**

```bash
ls supabase/migrations/
```

Confirm with the project owner which migrations are already live before applying `0024`. Apply `0023` first if it has not been.

- [ ] **Step 2: Apply `0024_autopilot.sql`**

Run it in the Supabase SQL editor for the project. Expected: two tables, three indexes, two policies, two triggers created with no errors.

- [ ] **Step 3: Register the cron job**

Follow `docs/autopilot-cron-setup.md`: a cron-job.org job at `/api/jobs/autopilot`, every 5 minutes, `Authorization: Bearer <CRON_SECRET>`.

- [ ] **Step 4: Smoke-test the route by hand**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/jobs/autopilot
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/jobs/autopilot
```

Expected: the first returns a JSON summary; the second prints `401`.

- [ ] **Step 5: Turn on one category and watch it**

Turn on autopilot for a single low-stakes category, then check `/autopilot` over the next 15 minutes. Expected sequence: a run appears at `sourcing`, moves to `awaiting_images`, then `succeeded`, and the post shows up in Buffer's queue. Confirm in Buffer before turning on the rest.

- [ ] **Step 6: Commit any doc updates**

```bash
git add -A
git commit -m "docs: autopilot deploy notes"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 data model, RLS, triggers, no `brand_id`, `set null` on `idea_id` | 1 |
| §4 period computation, settle, live-run advance, gap measurement, run opening | 2, 3, 8 |
| §4 one app-wide cron, `CRON_SECRET`, fails closed, per-tenant BYOK via `workflow.user_id` | 8, 9 |
| §5 four sourcing tiers, tier-1 post-group carry-forward, tier-4 one-per-tick cap, `IDEA_BATCH` leftovers | 4, 8 |
| §6 `awaiting_images` observes, stall deadline, `scheduleValidatedPost` reuse, channel/caption/null-time, partial-channel handling | 5, 6, 8 |
| §7 three brakes | 3 (`quotaGap`, `settlePeriod`), 8 (tick budget) |
| §8 UI: workflow list, live state in words, toggle, runs feed | 10 |
| §9 testing: period, quota, sourcing, run step, settle, route auth | 2, 3, 4, 5, 9 |
| §10 out of scope | not built, by design |

Two spec items are covered differently than a literal reading would suggest, and deliberately so: the "turn on for every category" bulk action ships as the per-row toggle plus a `saveWorkflows` action (Task 10, Step 5) rather than a separate bulk button, and the per-row settings dialog is deferred — Task 10's row exposes the toggle and shows the settings, while rate/timezone edits go through `saveWorkflow`. If the owner wants the dialog in v1, add it as a follow-up task rather than expanding Task 10.

**Placeholder scan:** no TBDs, no "add error handling", no "similar to Task N". Every code step carries the actual code.

**Type consistency:** `IdeaCandidate`, `SourceDecision`, `AwaitingDecision`, `QuotaDecision`, `SettleDecision`, `WorkflowSettings`, `WorkflowStatus`, and `TickSummary` are each defined once and consumed with the same field names in Task 8 and Task 10. `selectSource` returns `source` values that match the `AutopilotSource` union and the migration's `check` constraint. `scheduleValidatedPost`'s widened `scheduledAt` (Task 6) is what Task 8 passes `null` to.
