import { describe, it, expect, vi, beforeEach } from "vitest";

const updates: Record<string, unknown>[] = [];
// vi.hoisted, because the vi.mock factory below is itself hoisted above this
// file's top-level consts and would otherwise read the binding in its TDZ.
const { scheduleValidatedPost } = vi.hoisted(() => ({ scheduleValidatedPost: vi.fn() }));

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
    // failRun logs the reason on purpose; silenced so a passing run's output
    // stays clean, and restored so a genuinely unexpected error still shows.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = await runAutopilotTick(new Date("2026-08-14T12:10:00Z"));
    logged.mockRestore();

    expect(scheduleValidatedPost).not.toHaveBeenCalled();
    expect(summary.workflowsExamined).toBe(1);
    const failed = updates.find((u) => u.state === "failed");
    expect(failed).toBeDefined();
    expect(String(failed!.error)).toMatch(/buffer/i);
  });
});
