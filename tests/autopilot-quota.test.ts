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
