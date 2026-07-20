import { describe, it, expect } from "vitest";
import { buildImagePrompt } from "@/lib/athena/image-prompt";

const SUFFIX =
  "\n\nReference the provided style image to maintain visual consistency in palette, illustration style, and layout.";

describe("buildImagePrompt", () => {
  it("composes style guide + content + consistency suffix (n8n parity)", () => {
    expect(buildImagePrompt("GUIDE", "CONTENT")).toBe(
      "GUIDE\n\nSPECIFIC CONTENT FOR THIS IMAGE:\nCONTENT" + SUFFIX,
    );
  });
  it("appends refinement notes inside the content section", () => {
    expect(buildImagePrompt("GUIDE", "CONTENT", "make the dog bigger")).toBe(
      "GUIDE\n\nSPECIFIC CONTENT FOR THIS IMAGE:\nCONTENT\n\nRefinement notes: make the dog bigger" + SUFFIX,
    );
  });
  it("treats empty notes as absent", () => {
    expect(buildImagePrompt("G", "C", "")).toBe(buildImagePrompt("G", "C"));
  });
});
