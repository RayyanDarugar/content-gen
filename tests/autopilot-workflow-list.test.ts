import { describe, it, expect, vi, beforeEach } from "vitest";

// One query as the stub saw it. listWorkflowsForUser runs under the admin
// client, which bypasses RLS, so what it asks for is the only thing standing
// between one brand's page and another brand's workflows.
interface Query {
  table: string;
  filters: [string, unknown][];
}

const db = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  queries: [] as Query[],
}));

function builderFor(table: string) {
  const q: Query = { table, filters: [] };
  db.queries.push(q);
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  for (const m of ["eq", "in"] as const) {
    builder[m] = vi.fn((col: string, value: unknown) => {
      q.filters.push([col, value]);
      return builder;
    });
  }
  builder.then = (resolve: (v: unknown) => unknown) => {
    const rows = db.rows[table] ?? [];
    // `categories` is filtered the way Postgres would, so brand scoping is
    // real. `autopilot_workflows` deliberately is NOT: returning every row
    // regardless of the `.in(...)` is what exercises the second line of
    // defence — the TypeScript-side join that drops a workflow whose category
    // is not in this brand's set.
    const data = table === "categories"
      ? rows.filter((r) => q.filters.every(([col, value]) => r[col] === value))
      : rows;
    return resolve({ data, error: null });
  };
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({ from: (table: string) => builderFor(table) }),
}));

import { listWorkflowsForUser } from "@/lib/autopilot/workflow-mutations";

const CATEGORY = {
  id: "c-1", key: "cat1", name: "Cat 1", active: true,
  user_id: "user-1", brand_id: "brand-1",
};

const WORKFLOW = {
  id: "wf-1", user_id: "user-1", category_id: "c-1", posts_per_period: 1,
  period: "day", timezone: "UTC", max_attempts_per_period: 3,
  auto_pause_after_failed_periods: 3, consecutive_failed_periods: 0,
  last_settled_period: null, last_ticked_at: null, active: true, paused_reason: "",
  created_at: "2026-08-14T00:00:00Z", updated_at: "2026-08-14T00:00:00Z",
};

describe("listWorkflowsForUser", () => {
  beforeEach(() => {
    db.rows = {};
    db.queries = [];
  });

  it("excludes a workflow whose category belongs to a different brand", async () => {
    db.rows.categories = [
      CATEGORY,
      { ...CATEGORY, id: "c-2", key: "cat2", name: "Cat 2", brand_id: "brand-2" },
    ];
    db.rows.autopilot_workflows = [
      WORKFLOW,
      { ...WORKFLOW, id: "wf-2", category_id: "c-2" },
    ];

    const result = await listWorkflowsForUser("user-1", "brand-1");

    expect(result.map((w) => w.id)).toEqual(["wf-1"]);
    expect(result[0].category.key).toBe("cat1");
    // The first line of defence: the workflow query is narrowed to this
    // brand's categories rather than relying on the join alone.
    const workflowQuery = db.queries.find((q) => q.table === "autopilot_workflows");
    expect(workflowQuery?.filters).toContainEqual(["user_id", "user-1"]);
    expect(workflowQuery?.filters).toContainEqual(["category_id", ["c-1"]]);
  });

  it("returns nothing for a brand with no categories, without querying workflows at all", async () => {
    db.rows.categories = [{ ...CATEGORY, brand_id: "brand-2" }];
    db.rows.autopilot_workflows = [WORKFLOW];

    const result = await listWorkflowsForUser("user-1", "brand-1");

    expect(result).toEqual([]);
    // `.in("category_id", [])` is not merely wasteful — PostgREST renders an
    // empty list as `in.()`, which the server rejects. The early return is
    // what keeps it from ever being issued.
    expect(db.queries.map((q) => q.table)).toEqual(["categories"]);
  });
});
