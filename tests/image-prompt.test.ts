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

describe("buildSlidePrompt — role guides", () => {
  const guides = {
    hook: "Orange MYTH tag top-left. Statement struck through with a hand-drawn X.",
    beat: "No tag, no X. This panel explains rather than debunks.",
    payoff: "No tag, no X. The resolved truth, stated clean.",
  };

  it("applies only the guide for this slide's role", () => {
    const beat = buildSlidePrompt("G", { role: "beat", text: "t", visual: "v" }, 2, 5, true, "", guides);
    expect(beat).toContain("explains rather than debunks");
    expect(beat).not.toContain("MYTH tag");
    expect(beat).not.toContain("resolved truth");
  });

  it("gives the hook its own treatment", () => {
    const hook = buildSlidePrompt("G", { role: "hook", text: "t", visual: "v" }, 1, 5, false, "", guides);
    expect(hook).toContain("MYTH tag");
    expect(hook).not.toContain("explains rather than debunks");
  });

  it("keeps the payoff free of the hook's strike-through treatment", () => {
    const payoff = buildSlidePrompt("G", { role: "payoff", text: "t", visual: "v" }, 5, 5, true, "", guides);
    expect(payoff).toContain("resolved truth");
    expect(payoff).not.toContain("struck through");
  });

  it("omits the section entirely when the role has no guide", () => {
    const p = buildSlidePrompt("G", { role: "single", text: "t", visual: "v" }, 1, 1, false, "", guides);
    expect(p).not.toContain("TREATMENT FOR THIS PANEL");
  });

  it("omits the section when role guides are absent altogether", () => {
    const p = buildSlidePrompt("G", { role: "hook", text: "t", visual: "v" }, 1, 5, false);
    expect(p).not.toContain("TREATMENT FOR THIS PANEL");
  });

  it("treats a whitespace-only guide as absent", () => {
    const p = buildSlidePrompt("G", { role: "hook", text: "t", visual: "v" }, 1, 5, false, "", { hook: "   " });
    expect(p).not.toContain("TREATMENT FOR THIS PANEL");
  });

  it("keeps the blanket follow-every-rule clause when no role guide applies", () => {
    const p = buildSlidePrompt("G", { role: "hook", text: "t", visual: "v" }, 1, 5, false);
    expect(p).toContain("including any element it specifies as appearing on every panel");
  });

  it("gives the role treatment precedence when it conflicts with the style guide, " +
    "and drops the blanket follow-every-rule clause", () => {
    const conflictingGuide =
      "Every panel must show an orange MYTH tag and a hand-drawn strike-through X.";
    const guides = { payoff: "No tag, no X. The resolved truth, stated clean." };
    const p = buildSlidePrompt(
      conflictingGuide, { role: "payoff", text: "t", visual: "v" }, 5, 5, true, "", guides,
    );
    expect(p).toContain(
      "Where this treatment conflicts with the style guide, this treatment governs this panel.",
    );
    expect(p).not.toContain("including any element it specifies as appearing on every panel");
  });
});
