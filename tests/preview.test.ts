import { describe, expect, it } from "vitest";
import { buildPreviewPrompts } from "@/lib/athena/preview";
import type { Slide } from "@/lib/types";

const slides: Slide[] = [
  { role: "hook", text: "MYTH: cramming works", visual: "wide shot, desk at night" },
  { role: "beat", text: "Your brain needs sleep", visual: "close-up, alarm clock" },
  { role: "payoff", text: "Spaced practice wins", visual: "tight crop, calm morning" },
];
const category = {
  style_guide: "Cream background, flat illustration.",
  role_guides: { hook: "Orange MYTH tag top-left" },
};

describe("buildPreviewPrompts", () => {
  it("builds an unchained anchor prompt from slide 0", () => {
    const { anchor } = buildPreviewPrompts(category, slides);
    expect(anchor).toContain("MYTH: cramming works");
    expect(anchor).toContain("Panel 1 of 3");
    expect(anchor).toContain("Reference the provided style image");
    expect(anchor).toContain("Orange MYTH tag top-left"); // hook role guide applied
  });
  it("builds chained prompts for every later slide", () => {
    const { fanout } = buildPreviewPrompts(category, slides);
    expect(fanout).toHaveLength(2);
    expect(fanout[0]).toContain("Panel 2 of 3");
    expect(fanout[0]).toContain("Two reference images");
    expect(fanout[1]).toContain("Panel 3 of 3");
  });
  it("handles a single-slide independent preview with no fanout", () => {
    const single: Slide[] = [{ role: "single", text: "One tip", visual: "flat lay" }];
    const { anchor, fanout } = buildPreviewPrompts(category, single);
    expect(anchor).toContain("One tip");
    expect(fanout).toEqual([]);
  });
});
