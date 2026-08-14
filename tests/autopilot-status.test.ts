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

  it("gives the publishing claim state words of its own", () => {
    // `publishing` was added to AutopilotRunState after this helper's first
    // draft. Without an entry it would fall through to the raw column value,
    // which is the one state a human is most likely to see mid-post.
    const s = describeWorkflowStatus({ ...base, liveState: "publishing", attemptsUsed: 1 });
    expect(s.tone).toBe("working");
    expect(s.label).toBe("attempt 1 of 3 — sending to Buffer");
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
