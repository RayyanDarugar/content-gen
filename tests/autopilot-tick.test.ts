import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

// One query the tick issued, as the stub saw it. Recording the filters is the
// point: the tick runs under the admin client, which bypasses RLS, so a
// dropped `.eq("user_id", …)` is a cross-tenant leak that no type or runtime
// error would ever surface.
interface Query {
  table: string;
  op: "select" | "update" | "insert";
  filters: [string, unknown][];
  values: Record<string, unknown> | null;
}

const db = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  // The run's committed state, so the stub can honour a conditional update the
  // way Postgres would — this is what makes the claim test meaningful.
  runState: "",
  queries: [] as Query[],
  scheduleValidatedPost: vi.fn(),
}));

function resolveQuery(q: Query): { data: unknown[]; error: null; count: number } {
  if (q.op === "update") {
    // A conditional update (`.eq("state", …)`) matches nothing once the
    // committed state has moved on — exactly what the loser of a race sees.
    const stateFilter = q.filters.find(([col]) => col === "state");
    if (stateFilter && stateFilter[1] !== db.runState) return { data: [], error: null, count: 0 };
    const next = q.values?.state;
    if (q.table === "autopilot_runs" && typeof next === "string") db.runState = next;
    return { data: [{ id: "updated" }], error: null, count: 1 };
  }
  if (q.op === "insert") {
    const payload = q.values ?? {};
    if (q.table === "autopilot_runs" && typeof payload.state === "string") {
      db.runState = payload.state;
    }
    return {
      data: [{
        id: "run-new", source: "", idea_id: null, post_group_id: null, error: "", steps: [],
        created_at: "2026-08-14T12:00:00Z", updated_at: "2026-08-14T12:00:00Z", ...payload,
      }],
      error: null,
      count: 1,
    };
  }
  const rows = db.rows[q.table] ?? [];
  return { data: rows, error: null, count: rows.length };
}

// One chainable stub standing in for the whole query builder, recording each
// query so the test can assert on what the tick asked for as well as what it
// wrote. A fresh builder per from() call keeps one query's filters separate.
function builderFor(table: string) {
  const q: Query = { table, op: "select", filters: [], values: null };
  db.queries.push(q);
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  // select() also appears AFTER update()/insert() to return affected rows, so
  // it must not overwrite the operation already recorded.
  for (const m of ["select", "order", "limit"]) builder[m] = vi.fn(chain);
  for (const m of ["eq", "in", "neq", "gte", "lt"]) {
    builder[m] = vi.fn((col: string, value: unknown) => {
      q.filters.push([col, value]);
      return builder;
    });
  }
  for (const op of ["update", "insert", "upsert"] as const) {
    builder[op] = vi.fn((values: Record<string, unknown>) => {
      q.op = op === "upsert" ? "insert" : op;
      q.values = values;
      return builder;
    });
  }
  builder.maybeSingle = vi.fn(async () => ({ data: resolveQuery(q).data[0] ?? null, error: null }));
  builder.single = vi.fn(async () => ({ data: resolveQuery(q).data[0] ?? null, error: null }));
  builder.then = (resolve: (v: unknown) => unknown) => resolve(resolveQuery(q));
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({ from: (table: string) => builderFor(table) }),
}));
// vi.hoisted, because the vi.mock factories are themselves hoisted above this
// file's top-level consts and would otherwise read the binding in its TDZ.
vi.mock("@/app/api/posts/create/route", () => ({
  scheduleValidatedPost: db.scheduleValidatedPost,
}));
vi.mock("@/lib/athena/generate-ideas", () => ({ generateIdeas: vi.fn() }));
vi.mock("@/lib/athena/submit-generations", () => ({ submitGenerations: vi.fn() }));

import { runAutopilotTick } from "@/lib/autopilot/tick";

const NOW = new Date("2026-08-14T12:10:00Z");

const WORKFLOW = {
  id: "wf-1", user_id: "user-1", category_id: "c-1", posts_per_period: 1,
  period: "day", timezone: "UTC", max_attempts_per_period: 3,
  auto_pause_after_failed_periods: 3, consecutive_failed_periods: 0,
  last_settled_period: "2026-08-14", last_ticked_at: null, active: true, paused_reason: "",
  created_at: "2026-08-14T00:00:00Z", updated_at: "2026-08-14T00:00:00Z",
  category: {
    id: "c-1", key: "cat1", name: "Cat 1", active: true, brand_id: "b-1",
    buffer_connection_id: "conn-1", buffer_channel_id: "chan-1",
    buffer_channel_service: "instagram", post_caption: "fallback caption",
  },
};

const RUN = {
  id: "run-1", user_id: "user-1", workflow_id: "wf-1", category_key: "cat1",
  period_start: "2026-08-14", attempt_no: 1, state: "posting", source: "ready_images",
  idea_id: "idea-1", post_group_id: null, error: "", steps: [],
  created_at: "2026-08-14T12:00:00Z", updated_at: "2026-08-14T12:00:00Z",
};

const IDEA = {
  id: "idea-1", user_id: "user-1", category_key: "cat1", status: "generated",
  slides: [{ role: "hook" }], post_text: "idea copy", created_at: "2026-08-14T09:00:00Z",
};

const GENERATION = {
  id: "gen-1", idea_id: "idea-1", slide_index: 0, anchor_generation_id: null,
  status: "succeeded", created_at: "2026-08-14T10:00:00Z",
};

function updatesTo(table: string): Record<string, unknown>[] {
  return db.queries
    .filter((q) => q.table === table && q.op === "update" && q.values)
    .map((q) => q.values as Record<string, unknown>);
}

function queriesTo(table: string): Query[] {
  return db.queries.filter((q) => q.table === table);
}

function filterOn(q: Query, method: string, column: string): unknown {
  // Filters are recorded flat, so a column filtered by two methods (created_at
  // by both gte and lt) is disambiguated by looking at the builder call order.
  const calls = q.filters.filter(([col]) => col === column);
  if (method === "gte") return calls[0]?.[1];
  return calls[1]?.[1];
}

// Every query except the app-wide workflow sweep must name its tenant.
function unscopedQueries(): string[] {
  return db.queries
    .filter((q) =>
      q.op === "insert"
        ? !(q.values && "user_id" in q.values)
        : !q.filters.some(([col]) => col === "user_id"))
    .map((q) => `${q.table}.${q.op}`);
}

describe("runAutopilotTick", () => {
  let errorLog: MockInstance;
  let warnLog: MockInstance;

  beforeEach(() => {
    db.rows = {};
    db.queries = [];
    db.runState = "";
    db.scheduleValidatedPost.mockReset();
    // failRun and claimRun log on purpose; silenced so a passing run's output
    // stays clean. The summary.errors assertions below are what guard against
    // a real exception hiding behind this.
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorLog.mockRestore();
    warnLog.mockRestore();
  });

  it("fails the run instead of posting when the category has no Buffer channel", async () => {
    db.rows.autopilot_workflows = [{
      ...WORKFLOW,
      category: { ...WORKFLOW.category, buffer_connection_id: null, buffer_channel_id: "" },
    }];
    db.rows.autopilot_runs = [RUN];
    db.runState = "posting";

    const summary = await runAutopilotTick(NOW);

    expect(db.scheduleValidatedPost).not.toHaveBeenCalled();
    expect(summary.workflowsExamined).toBe(1);
    expect(summary.errors).toEqual([]);
    const failed = updatesTo("autopilot_runs").find((u) => u.state === "failed");
    expect(failed).toBeDefined();
    expect(String(failed!.error)).toMatch(/buffer/i);
    expect(unscopedQueries()).toEqual(["autopilot_workflows.select"]);
  });

  it("bounds the settled period's landed count by the next period's start, and the open period's not at all", async () => {
    // Yesterday's period is still the settled one, so this tick judges it.
    db.rows.autopilot_workflows = [{ ...WORKFLOW, last_settled_period: "2026-08-13" }];
    db.rows.autopilot_runs = [];
    db.rows.posts = [{ post_group_id: "pg-1" }];

    const summary = await runAutopilotTick(NOW);

    const counts = queriesTo("posts");
    expect(counts).toHaveLength(2);
    // The ENDED period: bounded above by the open period's start. Without the
    // upper bound today's post would settle yesterday and hide a real miss.
    expect(filterOn(counts[0], "gte", "created_at")).toBe("2026-08-13T00:00:00.000Z");
    expect(filterOn(counts[0], "lt", "created_at")).toBe("2026-08-14T00:00:00.000Z");
    // The OPEN period: no upper bound, because it has not ended.
    expect(filterOn(counts[1], "gte", "created_at")).toBe("2026-08-14T00:00:00.000Z");
    expect(filterOn(counts[1], "lt", "created_at")).toBeUndefined();

    const settled = updatesTo("autopilot_workflows").find((u) => "last_settled_period" in u);
    expect(settled).toMatchObject({
      last_settled_period: "2026-08-14", consecutive_failed_periods: 0, active: true,
    });
    expect(summary.errors).toEqual([]);
    expect(unscopedQueries()).toEqual(["autopilot_workflows.select"]);
  });

  it("opens an attempt, sources a ready carousel, and posts it on Buffer's own queue", async () => {
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [];
    db.rows.posts = [];
    db.rows.ideas = [IDEA];
    db.rows.generations = [GENERATION];
    db.rows.post_images = [];
    db.scheduleValidatedPost.mockResolvedValue({
      postGroupId: "pg-new", results: [{ status: "queued", error: "" }], allFailed: false,
    });

    const summary = await runAutopilotTick(NOW);

    expect(summary.runsOpened).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(db.scheduleValidatedPost).toHaveBeenCalledTimes(1);
    expect(db.scheduleValidatedPost).toHaveBeenCalledWith("user-1", expect.objectContaining({
      categoryKey: "cat1",
      generationIds: ["gen-1"],
      // null → the post rides Buffer's queue rather than a clock time.
      scheduledAt: null,
      caption: "idea copy",
    }));
    expect(updatesTo("autopilot_runs").some((u) => u.state === "succeeded")).toBe(true);
    expect(unscopedQueries()).toEqual(["autopilot_workflows.select"]);
  });

  it("refuses to re-post a run abandoned mid-publish whose carousel already went out", async () => {
    // The crash path: a tick died between the Buffer call and its terminal
    // write, leaving the run claimed. No competing claim exists to lose, so
    // the images' own post history is the only thing standing between this
    // run and a duplicate live post.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [{ ...RUN, state: "publishing" }];
    db.rows.ideas = [IDEA];
    db.rows.generations = [GENERATION];
    db.rows.post_images = [{ generation_id: "gen-1", post: { status: "queued" } }];
    db.rows.posts = [];
    db.runState = "publishing";

    const summary = await runAutopilotTick(NOW);

    expect(db.scheduleValidatedPost).not.toHaveBeenCalled();
    const failed = updatesTo("autopilot_runs").find((u) => u.state === "failed");
    expect(String(failed?.error)).toMatch(/already has a live post/i);
    expect(summary.errors).toEqual([]);
    expect(unscopedQueries()).toEqual(["autopilot_workflows.select"]);
  });

  it("does not post twice when a second tick advances the same run", async () => {
    // Both ticks read the run as `posting` — the stale read two overlapping
    // ticks get, and the one the unique index on run CREATION cannot prevent.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [RUN];
    db.rows.ideas = [IDEA];
    db.rows.generations = [GENERATION];
    db.rows.post_images = [];
    db.rows.posts = [];
    db.runState = "posting";
    db.scheduleValidatedPost.mockResolvedValue({
      postGroupId: "pg-new", results: [{ status: "queued", error: "" }], allFailed: false,
    });

    const first = await runAutopilotTick(NOW);
    const second = await runAutopilotTick(NOW);

    expect(db.scheduleValidatedPost).toHaveBeenCalledTimes(1);
    expect(updatesTo("autopilot_runs").filter((u) => u.state === "succeeded")).toHaveLength(1);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });
});
