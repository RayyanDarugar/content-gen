import { describe, it, expect, vi } from "vitest";
import {
  applyFilterDecisions, filterWithFallback, FILTER_FAILED_REASON,
} from "@/lib/athena/filter";

const ideas = [
  { idea_id: "a", category: "COMIC", concept: "one" },
  { idea_id: "b", category: "COMIC", concept: "two" },
];

describe("applyFilterDecisions", () => {
  it("applies keep/reject decisions by idea_id", () => {
    const out = applyFilterDecisions(ideas, [
      { idea_id: "a", keep: true, reason: "fresh" },
      { idea_id: "b", keep: false, reason: "cliche" },
    ]);
    expect(out[0]).toMatchObject({ idea_id: "a", ai_keep: true, ai_filter_reason: "fresh" });
    expect(out[1]).toMatchObject({ idea_id: "b", ai_keep: false, ai_filter_reason: "cliche" });
  });
  it("defaults to keep when a decision is missing", () => {
    const out = applyFilterDecisions(ideas, [{ idea_id: "a", keep: false, reason: "no" }]);
    expect(out[1]).toMatchObject({
      ai_keep: true,
      ai_filter_reason: "no decision returned — defaulting to keep",
    });
  });
  it("preserves extra fields (e.g. slides) carried on the idea beyond the base shape", () => {
    const withSlides = [
      { idea_id: "a", category: "COMIC", concept: "one", slides: [{ role: "single", text: "t", visual: "v" }] },
    ];
    const out = applyFilterDecisions(withSlides, [{ idea_id: "a", keep: true, reason: "fresh" }]);
    expect(out[0].slides).toEqual([{ role: "single", text: "t", visual: "v" }]);
  });
});

// The filter is a quality gate on an ALREADY-PAID generation call. When the
// gate itself breaks — truncated JSON, a 500, anything — throwing discards a
// batch of good ideas. Keeping everything unreviewed is the cheap failure.
describe("filterWithFallback", () => {
  it("applies decisions when the pass succeeds", async () => {
    const res = await filterWithFallback(ideas, async () => [
      { idea_id: "a", keep: true, reason: "fresh" },
      { idea_id: "b", keep: false, reason: "cliche" },
    ]);
    expect(res.filterFailed).toBe(false);
    expect(res.merged.map((i) => i.ai_keep)).toEqual([true, false]);
  });

  it("keeps every idea when the pass throws, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await filterWithFallback(ideas, async () => {
      throw new Error("Failed to parse structured output as JSON");
    });
    expect(res.filterFailed).toBe(true);
    expect(res.merged.every((i) => i.ai_keep)).toBe(true);
    expect(res.merged[0].ai_filter_reason).toBe(FILTER_FAILED_REASON);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not conflate a broken pass with a pass that simply skipped an idea", async () => {
    const res = await filterWithFallback(ideas, async () => [
      { idea_id: "a", keep: true, reason: "fresh" },
    ]);
    expect(res.filterFailed).toBe(false);
    expect(res.merged[1].ai_filter_reason).not.toBe(FILTER_FAILED_REASON);
  });
});
