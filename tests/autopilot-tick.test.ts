import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

// One query the tick issued, as the stub saw it. Recording the filters is the
// point: the tick runs under the admin client, which bypasses RLS, so a
// dropped `.eq("user_id", …)` is a cross-tenant leak that no type or runtime
// error would ever surface.
interface Query {
  table: string;
  op: "select" | "update" | "insert";
  filters: [string, unknown][];
  // The same filters with their method kept, used to actually narrow the
  // fixture rows. `filters` stays flat because unscopedQueries and filterOn
  // read it.
  applied: { method: string; column: string; value: unknown }[];
  values: Record<string, unknown> | null;
}

const db = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  // The run's committed state, so the stub can honour a conditional update the
  // way Postgres would — this is what makes the claim test meaningful.
  runState: "",
  queries: [] as Query[],
  scheduleValidatedPost: vi.fn(),
  generateIdeas: vi.fn(),
  submitGenerations: vi.fn(),
}));

// Selects NARROW the fixture rows rather than returning all of them. Without
// this, a query for "runs that quarantined this idea" and a query for "runs
// holding a live claim on it" would come back identical, and a test could not
// tell which mechanism excluded a candidate. Columns no fixture row declares
// are not filtered on: the fixtures are deliberately partial.
function applyFilters(rows: Record<string, unknown>[], q: Query): Record<string, unknown>[] {
  let out = rows;
  for (const f of q.applied) {
    if (!out.some((row) => f.column in row)) continue;
    out = out.filter((row) => {
      const v = row[f.column];
      if (f.method === "eq") return v === f.value;
      if (f.method === "neq") return v !== f.value;
      if (f.method === "in") return (f.value as unknown[]).includes(v);
      if (f.method === "lt") return String(v) < String(f.value);
      return String(v) >= String(f.value);
    });
  }
  return out;
}

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
  const rows = applyFilters(db.rows[q.table] ?? [], q);
  return { data: rows, error: null, count: rows.length };
}

// One chainable stub standing in for the whole query builder, recording each
// query so the test can assert on what the tick asked for as well as what it
// wrote. A fresh builder per from() call keeps one query's filters separate.
function builderFor(table: string) {
  const q: Query = { table, op: "select", filters: [], applied: [], values: null };
  db.queries.push(q);
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  // select() also appears AFTER update()/insert() to return affected rows, so
  // it must not overwrite the operation already recorded.
  for (const m of ["select", "order", "limit"]) builder[m] = vi.fn(chain);
  for (const m of ["eq", "in", "neq", "gte", "lt"]) {
    builder[m] = vi.fn((col: string, value: unknown) => {
      q.filters.push([col, value]);
      q.applied.push({ method: m, column: col, value });
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
vi.mock("@/lib/athena/generate-ideas", () => ({ generateIdeas: db.generateIdeas }));
vi.mock("@/lib/athena/submit-generations", () => ({ submitGenerations: db.submitGenerations }));

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
  idea_id: "idea-1", post_group_id: null, awaiting_images_since: null,
  idea_quarantined: false, error: "", steps: [],
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
    db.generateIdeas.mockReset();
    db.submitGenerations.mockReset();
    // The ordinary outcome; the tests that care about a bad submission say so.
    db.submitGenerations.mockResolvedValue({ submitted: 1, failed: 0, skipped: 0, errors: [] });
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

  it("mints the post group id BEFORE calling Buffer, not after", async () => {
    // The whole recovery story rests on this: a run found abandoned in
    // `publishing` can only ask `posts` what happened if the group it was
    // publishing under was already on the row when the tick died. Everything
    // createPostForUser writes (posts, post_images) lands AFTER postToBuffer
    // returns, so nothing written by the post itself can close that window.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [RUN];
    db.rows.ideas = [IDEA];
    db.rows.generations = [GENERATION];
    db.rows.post_images = [];
    db.rows.posts = [];
    db.runState = "posting";
    let groupsOnRowWhenBufferWasCalled: unknown[] = [];
    db.scheduleValidatedPost.mockImplementation(async () => {
      groupsOnRowWhenBufferWasCalled = updatesTo("autopilot_runs")
        .map((u) => u.post_group_id)
        .filter(Boolean);
      return { postGroupId: "pg-new", results: [{ status: "queued", error: "" }], allFailed: false };
    });

    const summary = await runAutopilotTick(NOW);

    const claim = updatesTo("autopilot_runs").find((u) => u.state === "publishing");
    expect(claim?.post_group_id).toEqual(expect.any(String));
    // Already persisted at the moment of the irreversible call, not merely
    // present by the end of the tick.
    expect(groupsOnRowWhenBufferWasCalled).toContain(claim!.post_group_id);
    expect(db.scheduleValidatedPost).toHaveBeenCalledWith("user-1", expect.objectContaining({
      postGroupId: claim!.post_group_id,
    }));
    expect(summary.errors).toEqual([]);
  });

  it("settles a run abandoned in publishing from its own post group, without re-posting", async () => {
    // The tick was killed after createPostForUser wrote its rows. Those rows
    // are the record of what Buffer did, so the run is closed from them.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [{ ...RUN, state: "publishing", post_group_id: "pg-1" }];
    db.rows.ideas = [IDEA];
    db.rows.generations = [GENERATION];
    db.rows.post_images = [{ generation_id: "gen-1", post: { status: "queued" } }];
    db.rows.posts = [{
      post_group_id: "pg-1", user_id: "user-1", status: "queued", error: "",
      // After the claim (RUN.updated_at), so it is this attempt's own row.
      created_at: "2026-08-14T12:00:02Z",
    }];
    db.runState = "publishing";

    const summary = await runAutopilotTick(NOW);

    expect(db.scheduleValidatedPost).not.toHaveBeenCalled();
    const settled = updatesTo("autopilot_runs").find((u) => u.state === "succeeded");
    expect(settled).toBeDefined();
    // Something reached Buffer, so the idea is retired from autopilot whether
    // or not the writes that normally mark it spent got as far as landing.
    expect(settled!.idea_quarantined).toBe(true);
    expect(summary.errors).toEqual([]);
    expect(unscopedQueries()).toEqual(["autopilot_workflows.select"]);
  });

  it("retires an idea recovered as succeeded even though post_images never got written", async () => {
    // Kill point 5. createPostForUser writes in this order: posts row (proof
    // it published) → post_images → ideas.status = "posted". Killed between
    // the first and the second, the carousel is LIVE while every signal that
    // normally retires an idea is still saying it is fresh: post_images is
    // empty so postedGenerationIds finds nothing and hasNonFailedPost is
    // false, and the idea is still `generated`. The queued posts row hides
    // that today through countLandedGroups — but the quota resets next period
    // and tier 2 would publish the same carousel a second time.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [{ ...RUN, state: "publishing", post_group_id: "pg-1" }];
    db.rows.ideas = [IDEA];
    db.rows.generations = [GENERATION];
    db.rows.post_images = [];
    db.rows.posts = [{
      post_group_id: "pg-1", user_id: "user-1", status: "queued", error: "",
      created_at: "2026-08-14T12:00:02Z",
    }];
    db.runState = "publishing";

    const first = await runAutopilotTick(NOW);

    const settled = updatesTo("autopilot_runs").find((u) => u.state === "succeeded");
    expect(settled?.idea_quarantined).toBe(true);
    expect(first.errors).toEqual([]);

    // Now the period rolls: the quota window no longer covers that post, so
    // the gap reopens and sourcing runs again against the very same idea —
    // still `generated`, still fully imaged, still with no post_images. Only
    // the quarantine stands between it and a duplicate live post.
    db.queries = [];
    db.runState = "";
    db.rows.posts = [];
    db.rows.autopilot_runs = [{
      ...RUN, state: "succeeded", post_group_id: "pg-1", idea_quarantined: true,
    }];
    db.generateIdeas.mockResolvedValue({ inserted: 0, filteredOut: 3, batchId: "b-1" });

    const second = await runAutopilotTick(NOW);

    expect(db.scheduleValidatedPost).not.toHaveBeenCalled();
    expect(second.errors).toEqual([]);
    expect(unscopedQueries()).toEqual(["autopilot_workflows.select"]);
  });

  it("does not accept a PRIOR attempt's row in a reused group as proof this one posted", async () => {
    // Tier 1 reuses the failed attempt's post_group_id on purpose, and
    // createPostForUser's cleanup only deletes prior FAILED rows on the SAME
    // channel. A leftover — a category whose Buffer channel changed between
    // attempts, or a cleanup delete that errored and was only logged — would
    // otherwise look like this attempt's own record, settle the run as
    // "every channel failed", and hand tier 1 a carousel that may be live.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [{
      ...RUN, state: "publishing", post_group_id: "pg-1", source: "retry_images",
    }];
    db.rows.ideas = [IDEA];
    db.rows.generations = [GENERATION];
    db.rows.post_images = [];
    db.rows.posts = [{
      post_group_id: "pg-1", user_id: "user-1", status: "failed",
      error: "the channel rejected it", created_at: "2026-08-14T11:40:00Z",
    }];
    db.runState = "publishing";

    const summary = await runAutopilotTick(NOW);

    const failed = updatesTo("autopilot_runs").find((u) => u.state === "failed");
    expect(String(failed?.error)).toMatch(/abandoned mid-publish/i);
    expect(failed?.idea_quarantined).toBe(true);
    expect(db.scheduleValidatedPost).not.toHaveBeenCalled();
    expect(summary.errors).toEqual([]);
  });

  it("never re-posts a run abandoned in publishing with nothing on record, and quarantines its idea", async () => {
    // The irreducible window: killed between Buffer's response and any DB
    // write at all. post_images is empty and posts has no row for the group,
    // so nothing here can prove the carousel did NOT go out — and a Buffer
    // post cannot be un-posted. Fail loudly; never retry.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [{ ...RUN, state: "publishing", post_group_id: "pg-1" }];
    db.rows.ideas = [IDEA];
    db.rows.generations = [GENERATION];
    db.rows.post_images = [];
    db.rows.posts = [];
    db.runState = "publishing";

    const summary = await runAutopilotTick(NOW);

    expect(db.scheduleValidatedPost).not.toHaveBeenCalled();
    const failed = updatesTo("autopilot_runs").find((u) => u.state === "failed");
    expect(String(failed?.error)).toMatch(/abandoned mid-publish/i);
    expect(failed?.idea_quarantined).toBe(true);
    expect(summary.errors).toEqual([]);
    expect(unscopedQueries()).toEqual(["autopilot_workflows.select"]);
  });

  it("will not source a quarantined idea again, even though its carousel is ready and unposted", async () => {
    // The second half of the Critical: failing the abandoned run is not
    // enough on its own. The idea is still `generated`, still fully imaged,
    // still carries no non-failed post — so tiers 1 and 2 would hand the same
    // carousel to Buffer on the next attempt. Fixtures are IDENTICAL to the
    // "opens an attempt, sources a ready carousel, and posts it" test above
    // except for the quarantine flag, which is what makes that test this
    // one's control.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [{
      ...RUN, id: "run-0", state: "failed", idea_quarantined: true,
      error: "abandoned mid-publish — check Buffer before retrying",
    }];
    db.rows.ideas = [IDEA];
    db.rows.generations = [GENERATION];
    db.rows.post_images = [];
    db.rows.posts = [];
    // Sourcing falls all the way through to tier 4 rather than posting; make
    // that terminate cleanly instead of on an unstubbed mock.
    db.generateIdeas.mockResolvedValue({ inserted: 0, filteredOut: 3, batchId: "b-1" });

    const summary = await runAutopilotTick(NOW);

    expect(db.scheduleValidatedPost).not.toHaveBeenCalled();
    expect(summary.errors).toEqual([]);
    expect(unscopedQueries()).toEqual(["autopilot_workflows.select"]);
  });

  it("fails the run with the submission's own reason instead of waiting out the image deadline", async () => {
    // submitGenerations REPORTS rather than throws. Discarding its result
    // moved the run to awaiting_images with nothing in flight, and 30 minutes
    // later a human got "images stalled: 0 of 1 slides ready" — the symptom,
    // with the cause thrown away.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [];
    db.rows.ideas = [{ ...IDEA, status: "approved" }];
    db.rows.generations = [];
    db.rows.post_images = [];
    db.rows.posts = [];
    db.submitGenerations.mockResolvedValue({
      submitted: 0, failed: 1, skipped: 0, errors: ["no Kie API key on file"],
    });

    const summary = await runAutopilotTick(NOW);

    const states = updatesTo("autopilot_runs").map((u) => u.state);
    expect(states).not.toContain("awaiting_images");
    const failed = updatesTo("autopilot_runs").find((u) => u.state === "failed");
    expect(String(failed?.error)).toMatch(/no Kie API key on file/);
    expect(summary.errors).toEqual([]);
    expect(unscopedQueries()).toEqual(["autopilot_workflows.select"]);
  });

  it("stamps when a run entered awaiting_images, not just when it was created", async () => {
    // The stall deadline is measured from this stamp. Measuring from
    // created_at would fail a run that deferred in `sourcing` for longer than
    // IMAGE_DEADLINE_MINUTES the moment it finally paid for images.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [];
    db.rows.ideas = [{ ...IDEA, status: "approved" }];
    db.rows.generations = [];
    db.rows.post_images = [];
    db.rows.posts = [];

    await runAutopilotTick(NOW);

    const waiting = updatesTo("autopilot_runs").find((u) => u.state === "awaiting_images");
    expect(waiting?.awaiting_images_since).toEqual(expect.any(String));
  });

  it("withdraws the tier-4 idea-generation slot once the tick has burned enough clock", async () => {
    // generateIdeas makes two Anthropic calls with thinking and no per-call
    // timeout override; the spec budgets ~90s for it. Starting one late in a
    // 120s route is what leaves a run stranded in `publishing`.
    db.rows.autopilot_workflows = [WORKFLOW];
    db.rows.autopilot_runs = [];
    db.rows.ideas = [];
    db.rows.generations = [];
    db.rows.post_images = [];
    db.rows.posts = [];
    let t = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (t += 15_000));

    const summary = await runAutopilotTick(NOW);

    expect(db.generateIdeas).not.toHaveBeenCalled();
    expect(summary.stoppedEarly).toBe(false);
    expect(summary.errors).toEqual([]);
    const deferred = updatesTo("autopilot_runs").find((u) => Array.isArray(u.steps));
    expect(JSON.stringify(deferred?.steps)).toMatch(/defer/);
    clock.mockRestore();
  });

  it("breaks the sweep on its own wall-clock budget rather than being killed by maxDuration", async () => {
    // Being killed mid-loop is precisely what manufactures an abandoned
    // `publishing` run. Rotation via last_ticked_at makes the break harmless:
    // the workflow not reached keeps its place at the front of the queue, and
    // it is deliberately not stamped.
    db.rows.autopilot_workflows = [
      WORKFLOW,
      { ...WORKFLOW, id: "wf-2", category: { ...WORKFLOW.category, id: "c-2", key: "cat2" } },
    ];
    db.rows.autopilot_runs = [];
    db.rows.ideas = [];
    db.rows.generations = [];
    db.rows.post_images = [];
    db.rows.posts = [];
    let t = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (t += 50_000));

    const summary = await runAutopilotTick(NOW);

    expect(summary.stoppedEarly).toBe(true);
    expect(summary.workflowsExamined).toBe(1);
    const stamped = db.queries.filter(
      (q) => q.table === "autopilot_workflows" && q.op === "update"
        && q.values && "last_ticked_at" in q.values,
    );
    expect(stamped).toHaveLength(1);
    expect(summary.errors).toEqual([]);
    clock.mockRestore();
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
