import { describe, it, expect } from "vitest";
import { periodStart, periodStartUtc } from "@/lib/autopilot/period";

describe("periodStart", () => {
  it("uses the workflow's local calendar day, not UTC's", () => {
    // 2026-08-14T04:00Z is 2026-08-13 21:00 in Los Angeles.
    const now = new Date("2026-08-14T04:00:00Z");
    expect(periodStart(now, "America/Los_Angeles", "day")).toBe("2026-08-13");
    expect(periodStart(now, "UTC", "day")).toBe("2026-08-14");
  });

  it("rolls a weekly period back to the local ISO week's Monday", () => {
    // 2026-08-14 is a Friday.
    const now = new Date("2026-08-14T18:00:00Z");
    expect(periodStart(now, "UTC", "week")).toBe("2026-08-10");
  });

  it("treats Sunday as the END of its ISO week, not the start", () => {
    // 2026-08-16 is a Sunday; its ISO week began Monday the 10th.
    const now = new Date("2026-08-16T18:00:00Z");
    expect(periodStart(now, "UTC", "week")).toBe("2026-08-10");
  });

  it("handles a timezone ahead of UTC", () => {
    // 2026-08-13T20:00Z is already 2026-08-14 in Tokyo (UTC+9).
    const now = new Date("2026-08-13T20:00:00Z");
    expect(periodStart(now, "Asia/Tokyo", "day")).toBe("2026-08-14");
  });
});

describe("periodStartUtc", () => {
  it("resolves local midnight to the right instant", () => {
    expect(periodStartUtc("2026-08-14", "America/Los_Angeles").toISOString())
      .toBe("2026-08-14T07:00:00.000Z"); // PDT, UTC-7
    expect(periodStartUtc("2026-08-14", "UTC").toISOString())
      .toBe("2026-08-14T00:00:00.000Z");
  });

  it("uses the offset in force ON that date, across a DST boundary", () => {
    // US DST ends Sunday 2026-11-01. Midnight on the 1st is still PDT (-7);
    // midnight on the 2nd is PST (-8). A fixed offset would get one wrong.
    expect(periodStartUtc("2026-11-01", "America/Los_Angeles").toISOString())
      .toBe("2026-11-01T07:00:00.000Z");
    expect(periodStartUtc("2026-11-02", "America/Los_Angeles").toISOString())
      .toBe("2026-11-02T08:00:00.000Z");
  });

  it("handles the spring-forward side too", () => {
    // DST begins Sunday 2026-03-08; midnight that day is still PST (-8).
    expect(periodStartUtc("2026-03-08", "America/Los_Angeles").toISOString())
      .toBe("2026-03-08T08:00:00.000Z");
    expect(periodStartUtc("2026-03-09", "America/Los_Angeles").toISOString())
      .toBe("2026-03-09T07:00:00.000Z");
  });
});
