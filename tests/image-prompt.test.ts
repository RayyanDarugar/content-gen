import { describe, it, expect } from "vitest";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import type { Slide } from "@/lib/types";

const slide: Slide = { role: "beat", text: "So I did more.", visual: "Overhead desk view." };

describe("buildSlidePrompt", () => {
  it("leads with the style guide", () => {
    expect(buildSlidePrompt("GUIDE", slide, 2, 5, true).startsWith("GUIDE\n")).toBe(true);
  });

  it("includes the panel text and scene", () => {
    const p = buildSlidePrompt("GUIDE", slide, 2, 5, true);
    expect(p).toContain('Text on panel: "So I did more."');
    expect(p).toContain("Scene: Overhead desk view.");
  });

  it("states the panel position for a multi-slide carousel", () => {
    expect(buildSlidePrompt("GUIDE", slide, 2, 5, true)).toContain("Panel 2 of 5.");
  });

  it("omits panel position for a single-image post", () => {
    const single: Slide = { role: "single", text: "T", visual: "V" };
    expect(buildSlidePrompt("GUIDE", single, 1, 1, false)).not.toContain("Panel 1 of 1");
  });

  it("uses the one-reference note when unchained", () => {
    const p = buildSlidePrompt("GUIDE", slide, 1, 5, false);
    expect(p).toContain("Reference the provided style image");
    expect(p).not.toContain("Two reference images");
  });

  it("uses the two-reference note when chained", () => {
    const p = buildSlidePrompt("GUIDE", slide, 2, 5, true);
    expect(p).toContain("Two reference images are provided");
    expect(p).toContain("SECOND is the opening panel");
  });

  it("varies role direction by role", () => {
    const hook = buildSlidePrompt("G", { ...slide, role: "hook" }, 1, 5, false);
    const payoff = buildSlidePrompt("G", { ...slide, role: "payoff" }, 5, 5, true);
    expect(hook).toContain("ROLE DIRECTION:");
    expect(payoff).toContain("ROLE DIRECTION:");
    expect(hook).not.toBe(payoff);
  });

  it("carries refinement notes when present", () => {
    const p = buildSlidePrompt("G", slide, 2, 5, true, "make the dog bigger");
    expect(p).toContain("Refinement notes: make the dog bigger");
  });

  it("treats empty refinement notes as absent", () => {
    expect(buildSlidePrompt("G", slide, 2, 5, true, "")).toBe(
      buildSlidePrompt("G", slide, 2, 5, true),
    );
  });

  it("does not name a footer — that belongs to the style guide", () => {
    expect(buildSlidePrompt("GUIDE", slide, 2, 5, true).toLowerCase()).not.toContain("footer");
  });

  it("omits the text line entirely for a wordless panel", () => {
    const wordless: Slide = { role: "beat", text: "", visual: "An empty desk." };
    expect(buildSlidePrompt("G", wordless, 2, 5, true)).not.toContain("Text on panel:");
  });
});
