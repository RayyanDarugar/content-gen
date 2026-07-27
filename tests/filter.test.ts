import { describe, it, expect } from "vitest";
import { applyFilterDecisions } from "@/lib/athena/filter";

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
