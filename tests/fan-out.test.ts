import { describe, expect, it } from "vitest";
import { summarizeFanOut, type ChannelResult } from "@/lib/athena/fan-out";

const ok = (channelId: string): ChannelResult => ({ channelId, status: "queued", bufferUpdateId: "u1" });
const bad = (channelId: string): ChannelResult => ({ channelId, status: "failed", error: "nope" });

describe("summarizeFanOut", () => {
  it("summarizes a mixed run", () => {
    const s = summarizeFanOut([ok("a"), ok("b"), bad("c")]);
    expect(s).toMatchObject({ queued: 2, failed: 1, allFailed: false });
    expect(s.label).toBe("2 queued · 1 failed");
  });
  it("summarizes an all-success run", () => {
    const s = summarizeFanOut([ok("a"), ok("b"), ok("c")]);
    expect(s).toMatchObject({ queued: 3, failed: 0, allFailed: false });
    expect(s.label).toBe("3 queued");
  });
  it("flags an all-failed run", () => {
    const s = summarizeFanOut([bad("a"), bad("b")]);
    expect(s).toMatchObject({ queued: 0, failed: 2, allFailed: true });
    expect(s.label).toBe("2 failed");
  });
  it("handles an empty result list without claiming everything failed", () => {
    const s = summarizeFanOut([]);
    expect(s).toMatchObject({ queued: 0, failed: 0, allFailed: false });
  });

  it("still counts a queued result carrying a warning as queued, not failed", () => {
    const warned: ChannelResult = {
      channelId: "a",
      status: "queued",
      bufferUpdateId: "u1",
      warning: "posted but image records failed — this channel's slides may be offered again",
    };
    const s = summarizeFanOut([warned, bad("b")]);
    expect(s).toMatchObject({ queued: 1, failed: 1, allFailed: false });
    expect(s.label).toBe("1 queued · 1 failed");
  });
});
