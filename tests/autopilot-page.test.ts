import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RowProps } from "@/app/(app)/autopilot/workflow-row";

// The regression these tests exist for: a workflow's attempt count and live
// state must come from autopilot_runs itself, never from the fixed-size
// recent-runs feed the page also renders. On a brand with enough categories
// the feed can be entirely full of OTHER workflows' runs — and a page that
// derived either fact from it would then tell a human that a workflow which
// has burned every attempt is "still working".

const db = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  // What listRecentRunsForUser hands back. Held empty on purpose: it stands
  // for a feed whose 20 slots went to other categories entirely.
  feed: [] as Record<string, unknown>[],
}));

function builderFor(table: string) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ["select", "eq", "neq", "gte", "order"]) builder[m] = vi.fn(chain);
  builder.then = (resolve: (v: unknown) => unknown) => {
    const data = db.rows[table] ?? [];
    return resolve({ data, error: null, count: data.length });
  };
  return builder;
}

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: async () => ({ id: "user-1" }),
}));
vi.mock("@/lib/auth/active-brand", () => ({
  requireActiveBrand: async () => ({ id: "brand-1" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({ from: (table: string) => builderFor(table) }),
}));
vi.mock("@/lib/autopilot/workflow-mutations", () => ({
  listWorkflowsForUser: async () => db.rows.autopilot_workflows ?? [],
  listRecentRunsForUser: async () => db.feed,
}));
// Stubbed so the page's own client components (and their sonner/base-ui
// imports) stay out of this test. The stub prints the status it was handed,
// which is the whole subject here.
vi.mock("@/app/(app)/autopilot/workflow-row", () => ({
  WorkflowRow: (props: RowProps) =>
    createElement("div", null, `${props.categoryName}|${props.status.tone}|${props.status.label}`),
}));
vi.mock("@/app/(app)/autopilot/turn-on-all", () => ({
  TurnOnAll: () => null,
}));

import AutopilotPage from "@/app/(app)/autopilot/page";

const WORKFLOW = {
  id: "wf-1", user_id: "user-1", category_id: "c-1", posts_per_period: 1,
  period: "day", timezone: "UTC", max_attempts_per_period: 3,
  auto_pause_after_failed_periods: 3, consecutive_failed_periods: 0,
  last_settled_period: null, last_ticked_at: null, active: true, paused_reason: "",
  created_at: "2026-08-14T00:00:00Z", updated_at: "2026-08-14T00:00:00Z",
  category: { id: "c-1", key: "cat1", name: "Cat 1", active: true },
};

async function render(): Promise<string> {
  return renderToStaticMarkup(await AutopilotPage());
}

describe("AutopilotPage", () => {
  beforeEach(() => {
    db.rows = {
      categories: [{ id: "c-1", key: "cat1", name: "Cat 1" }],
      posts: [],
      autopilot_workflows: [WORKFLOW],
      autopilot_runs: [],
    };
    db.feed = [];
  });

  it("says a workflow gave up when its attempts are spent, even with an empty runs feed", async () => {
    db.rows.autopilot_runs = [
      { state: "failed" }, { state: "failed" }, { state: "failed" },
    ];

    expect(await render()).toContain(
      "Cat 1|paused|gave up for this period (3 of 3 attempts used)",
    );
  });

  it("shows the live step of a run that never appears in the runs feed", async () => {
    db.rows.autopilot_runs = [{ state: "failed" }, { state: "publishing" }];

    expect(await render()).toContain("Cat 1|working|attempt 2 of 3 — sending to Buffer");
  });

  it("still reports a workflow with attempts left as waiting", async () => {
    db.rows.autopilot_runs = [];

    expect(await render()).toContain("Cat 1|on|waiting to start (0/1 posted)");
  });
});
