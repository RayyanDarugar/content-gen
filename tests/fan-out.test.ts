import { describe, expect, it } from "vitest";
import { summarizeFanOut, sentSlidesByIdea, type ChannelResult } from "@/lib/athena/fan-out";

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

describe("sentSlidesByIdea", () => {
  const five = ["a", "b", "c", "d", "e"];
  const ordered = [
    { idea_id: "idea-1", slide_index: 0 },
    { idea_id: "idea-1", slide_index: 1 },
    { idea_id: "idea-1", slide_index: 2 },
    { idea_id: "idea-1", slide_index: 3 },
    { idea_id: "idea-1", slide_index: 4 },
  ];

  it("Critical: only counts an X channel's truncated 4-image prefix as sent, not slide 5", () => {
    const byIdea = sentSlidesByIdea(ordered, five, [{ service: "x", queued: true }]);
    expect(byIdea.get("idea-1")).toEqual(new Set([0, 1, 2, 3]));
  });

  it("counts every slide sent to a channel with no truncation", () => {
    const byIdea = sentSlidesByIdea(ordered, five, [{ service: "linkedin", queued: true }]);
    expect(byIdea.get("idea-1")).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it("Critical: a channel that failed contributes nothing, even though it was part of the request", () => {
    const byIdea = sentSlidesByIdea(ordered, five, [{ service: "linkedin", queued: false }]);
    expect(byIdea.get("idea-1")).toBeUndefined();
  });

  it("unions across channels — a slide truncated off X but sent in full to LinkedIn still counts as sent", () => {
    const byIdea = sentSlidesByIdea(ordered, five, [
      { service: "x", queued: true },
      { service: "linkedin", queued: true },
    ]);
    expect(byIdea.get("idea-1")).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it("a slide dropped by every queued channel's truncation is never marked sent anywhere", () => {
    const byIdea = sentSlidesByIdea(ordered, five, [
      { service: "x", queued: true },
      { service: "x", queued: false },
    ]);
    expect(byIdea.get("idea-1")).toEqual(new Set([0, 1, 2, 3]));
    expect(byIdea.get("idea-1")!.has(4)).toBe(false);
  });

  it("keys slides by each generation's own idea_id for a freeform multi-idea submission", () => {
    const mixed = [
      { idea_id: "idea-a", slide_index: 0 },
      { idea_id: "idea-b", slide_index: 2 },
    ];
    const byIdea = sentSlidesByIdea(mixed, ["u1", "u2"], [{ service: "linkedin", queued: true }]);
    expect(byIdea.get("idea-a")).toEqual(new Set([0]));
    expect(byIdea.get("idea-b")).toEqual(new Set([2]));
  });
});
