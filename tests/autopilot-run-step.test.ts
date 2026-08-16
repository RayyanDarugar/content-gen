import { describe, it, expect } from "vitest";
import { decideAwaitingImages, IMAGE_DEADLINE_MINUTES } from "@/lib/autopilot/run-step";

// When the run ENTERED awaiting_images — not when it was created. The two are
// far apart whenever sourcing deferred for a while first.
const startedAt = "2026-08-14T12:00:00Z";
const base = {
  slideCount: 3,
  readySlideIndexes: [] as number[],
  hasInFlightGeneration: true,
  awaitingSince: startedAt,
  now: new Date("2026-08-14T12:05:00Z"),
};

describe("decideAwaitingImages", () => {
  it("posts once every declared slide has resolved", () => {
    expect(decideAwaitingImages({ ...base, readySlideIndexes: [0, 1, 2] }))
      .toEqual({ action: "post" });
  });

  it("waits while generations are still in flight", () => {
    expect(decideAwaitingImages({ ...base, readySlideIndexes: [0] }))
      .toEqual({ action: "wait" });
  });

  it("waits through the gap between the anchor landing and fan-out starting", () => {
    // Nothing in flight yet the deadline has not passed: the poll cron fans
    // out on its own tick, so this is a normal gap, not a stall.
    expect(decideAwaitingImages({ ...base, readySlideIndexes: [0], hasInFlightGeneration: false }))
      .toEqual({ action: "wait" });
  });

  it("fails the run once nothing is in flight past the deadline", () => {
    const d = decideAwaitingImages({
      ...base,
      readySlideIndexes: [0],
      hasInFlightGeneration: false,
      now: new Date(Date.parse(startedAt) + (IMAGE_DEADLINE_MINUTES + 1) * 60_000),
    });
    expect(d.action).toBe("fail");
    if (d.action === "fail") {
      expect(d.error).toContain("1 of 3");
      expect(d.error).toContain(String(IMAGE_DEADLINE_MINUTES));
    }
  });

  it("keeps waiting past the deadline while work is still in flight", () => {
    // A slow Kie queue is not a stall — the poll cron's own cap ends it.
    expect(decideAwaitingImages({
      ...base,
      hasInFlightGeneration: true,
      now: new Date(Date.parse(startedAt) + (IMAGE_DEADLINE_MINUTES + 1) * 60_000),
    })).toEqual({ action: "wait" });
  });

  it("posts a complete carousel even past the deadline", () => {
    expect(decideAwaitingImages({
      ...base,
      readySlideIndexes: [0, 1, 2],
      hasInFlightGeneration: false,
      now: new Date(Date.parse(startedAt) + (IMAGE_DEADLINE_MINUTES + 1) * 60_000),
    })).toEqual({ action: "post" });
  });

  it("measures the deadline from the submission, not from a long-deferred run's birth", () => {
    // The regression: a run created at T can sit in `sourcing` for hours (the
    // tier-4 slot is one per tick, app-wide) before it pays for images. If the
    // deadline were measured from creation, the very first check after
    // submitting would already be "stalled" and would discard a carousel paid
    // for seconds earlier.
    const bornLongAgo = "2026-08-14T11:00:00Z";
    const submittedJustNow = "2026-08-14T12:04:00Z";
    expect(decideAwaitingImages({
      ...base,
      readySlideIndexes: [0],
      hasInFlightGeneration: false,
      awaitingSince: submittedJustNow,
      now: new Date("2026-08-14T12:05:00Z"),
    })).toEqual({ action: "wait" });
    // Same clock, same run, measured from birth instead: a false stall.
    expect(decideAwaitingImages({
      ...base,
      readySlideIndexes: [0],
      hasInFlightGeneration: false,
      awaitingSince: bornLongAgo,
      now: new Date("2026-08-14T12:05:00Z"),
    }).action).toBe("fail");
  });

  it("returns the same decision when called twice on the same state", () => {
    const input = { ...base, readySlideIndexes: [0, 1, 2] };
    expect(decideAwaitingImages(input)).toEqual(decideAwaitingImages(input));
  });
});
