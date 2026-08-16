import { describe, it, expect } from "vitest";
import { describeWorkflowStatus } from "@/lib/autopilot/status";

const base = {
  active: true,
  pausedReason: "",
  postsPerPeriod: 1,
  landedGroups: 0,
  attemptsUsed: 0,
  maxAttempts: 3,
  currentPeriod: "2026-08-14",
  live: null as { state: string; attemptNo: number; periodStart: string } | null,
};

function live(state: string, attemptNo: number, periodStart = "2026-08-14") {
  return { state, attemptNo, periodStart };
}

describe("describeWorkflowStatus", () => {
  it("reports a met quota", () => {
    const s = describeWorkflowStatus({ ...base, landedGroups: 1 });
    expect(s.tone).toBe("done");
    expect(s.label).toBe("posted 1/1");
  });

  it("does not call a workflow settled while a run is still live past its quota", () => {
    // tickWorkflow advances a live run BEFORE it measures the gap, so a run
    // still live past a satisfied quota is about to publish a post that takes
    // the category OVER its stated rate. "posted 1/1" with the done tone would
    // read as finished — the same lie as "waiting to start" reading as idle.
    const s = describeWorkflowStatus({
      ...base, landedGroups: 1, live: live("publishing", 2),
    });
    expect(s.tone).toBe("working");
    expect(s.label).toBe("posted 1/1 · attempt 2 of 3 — sending to Buffer");
  });

  it("names the step a live run is on, with its own attempt number", () => {
    const s = describeWorkflowStatus({
      ...base, live: live("awaiting_images", 2), attemptsUsed: 2,
    });
    expect(s.tone).toBe("working");
    expect(s.label).toBe("attempt 2 of 3 — generating images");
  });

  it("gives the publishing claim state words of its own", () => {
    // `publishing` was added to AutopilotRunState after this helper's first
    // draft. Without an entry it would fall through to the raw column value,
    // which is the one state a human is most likely to see mid-post.
    const s = describeWorkflowStatus({ ...base, live: live("publishing", 1), attemptsUsed: 1 });
    expect(s.tone).toBe("working");
    expect(s.label).toBe("attempt 1 of 3 — sending to Buffer");
  });

  it("says which period a straggler run came from", () => {
    // The regression: a run opened just before a rollover stays live across it
    // and keeps being advanced — the tick's live-run query has no period
    // filter. This period has zero attempts of its own, so numbering the
    // straggler from the current period's count would print "attempt 0", and
    // dropping it entirely would print "waiting to start" for a workflow about
    // to call Buffer.
    const s = describeWorkflowStatus({
      ...base, attemptsUsed: 0, live: live("posting", 2, "2026-08-13"),
    });
    expect(s.tone).toBe("working");
    expect(s.label).toBe("attempt 2 of 3 (from 2026-08-13) — posting");
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
