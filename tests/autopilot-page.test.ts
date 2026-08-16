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

// The stub APPLIES eq/in/neq filters rather than ignoring them, on any column
// the fixture rows actually carry. Without that, the page's live-run lookup
// (`.in("state", LIVE_STATES)`) would come back holding every run in the
// fixture, and a test asserting "gave up for this period" would pass even if
// the page were reading a `failed` run as live.
function builderFor(table: string) {
  const filters: { method: string; column: string; value: unknown }[] = [];
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ["select", "order", "limit"]) builder[m] = vi.fn(chain);
  for (const m of ["eq", "neq", "gte", "in"]) {
    builder[m] = vi.fn((column: string, value: unknown) => {
      filters.push({ method: m, column, value });
      return builder;
    });
  }
  builder.then = (resolve: (v: unknown) => unknown) => {
    let data = db.rows[table] ?? [];
    for (const f of filters) {
      // A column no fixture row declares is not filtered on — the fixtures are
      // deliberately partial, and inventing values for every column the page
      // filters by would make them unreadable.
      if (!data.some((row) => f.column in row)) continue;
      data = data.filter((row) => {
        const v = row[f.column];
        if (f.method === "eq") return v === f.value;
        if (f.method === "neq") return v !== f.value;
        if (f.method === "in") return (f.value as unknown[]).includes(v);
        return String(v) >= String(f.value);
      });
    }
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

// The workflow's timezone is UTC, so the page's own current period is the UTC
// calendar date. Derived rather than pinned so the file does not rot.
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function run(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "r-1", user_id: "user-1", workflow_id: "wf-1", category_key: "cat1",
    period_start: TODAY, attempt_no: 1, state: "succeeded", source: "ready_images",
    idea_id: null, post_group_id: null, awaiting_images_since: null,
    idea_quarantined: false, error: "", steps: [],
    created_at: "2026-08-14T12:00:00Z", updated_at: "2026-08-14T12:00:00Z",
    ...over,
  };
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
      { state: "failed", attempt_no: 1, period_start: TODAY },
      { state: "failed", attempt_no: 2, period_start: TODAY },
      { state: "failed", attempt_no: 3, period_start: TODAY },
    ];

    expect(await render()).toContain(
      "Cat 1|paused|gave up for this period (3 of 3 attempts used)",
    );
  });

  it("shows the live step of a run that never appears in the runs feed", async () => {
    db.rows.autopilot_runs = [
      { state: "failed", attempt_no: 1, period_start: TODAY },
      { state: "publishing", attempt_no: 2, period_start: TODAY },
    ];

    expect(await render()).toContain("Cat 1|working|attempt 2 of 3 — sending to Buffer");
  });

  it("still reports a workflow with attempts left as waiting", async () => {
    db.rows.autopilot_runs = [];

    expect(await render()).toContain("Cat 1|on|waiting to start (0/1 posted)");
  });

  it("reports a run still live from the previous period instead of 'waiting to start'", async () => {
    // The regression: runAutopilotTick's live-run query has no period filter,
    // so a run opened just before a rollover keeps being advanced across it —
    // up to and including a Buffer post. A page that only looked at the new
    // period's runs would render "waiting to start (0/1 posted)" for a
    // workflow that is actively spending money.
    db.rows.autopilot_runs = [
      { state: "awaiting_images", attempt_no: 2, period_start: YESTERDAY },
    ];

    const html = await render();
    expect(html).toContain(
      `Cat 1|working|attempt 2 of 3 (from ${YESTERDAY}) — generating images`,
    );
    expect(html).not.toContain("waiting to start");
  });

  it("renders a partial-channel success as a warning, not as a failure", async () => {
    db.feed = [
      run({ state: "succeeded", error: "partial: X rejected the media" }),
    ];

    const html = await render();
    expect(html).toContain("warning: partial: X rejected the media");
    expect(html).not.toContain("text-destructive");
  });

  it("renders a failed run's error in the failure treatment", async () => {
    db.feed = [run({ id: "r-2", state: "failed", error: "images stalled" })];

    const html = await render();
    expect(html).toContain("text-destructive");
    expect(html).toContain("images stalled");
    expect(html).not.toContain("warning:");
  });

  it("renders the steps log and the links spec §8 asks for", async () => {
    // `steps` is written by six call sites in the tick and, before this, read
    // by nothing — a write-only column is a log nobody can consult at 3am.
    db.feed = [
      run({
        id: "r-3", idea_id: "idea-9", post_group_id: "pg-123456789",
        steps: [
          { at: "2026-08-14T12:00:00Z", step: "source", detail: "ready_images → idea idea-9" },
          { at: "2026-08-14T12:00:05Z", step: "post", detail: "1 of 1 channels queued" },
        ],
      }),
    ];

    const html = await render();
    expect(html).toContain("ready_images → idea idea-9");
    expect(html).toContain("1 of 1 channels queued");
    expect(html).toContain('href="/post/idea-9"');
    expect(html).toContain("pg-12345");
  });
});
