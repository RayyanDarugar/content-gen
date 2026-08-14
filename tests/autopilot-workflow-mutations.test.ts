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
