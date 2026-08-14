import { describe, it, expect } from "vitest";
import { decideAwaitingImages, IMAGE_DEADLINE_MINUTES } from "@/lib/autopilot/run-step";

const startedAt = "2026-08-14T12:00:00Z";
const base = {
  slideCount: 3,
  readySlideIndexes: [] as number[],
  hasInFlightGeneration: true,
  runCreatedAt: startedAt,
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

  it("returns the same decision when called twice on the same state", () => {
    const input = { ...base, readySlideIndexes: [0, 1, 2] };
    expect(decideAwaitingImages(input)).toEqual(decideAwaitingImages(input));
  });
});
