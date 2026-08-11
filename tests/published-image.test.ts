import { describe, expect, it } from "vitest";
import { publishedImageUrl } from "@/lib/athena/published-image";

describe("publishedImageUrl", () => {
  it("prefers the composited artifact when one exists", () => {
    expect(publishedImageUrl({ public_url: "clean.jpg", composited_url: "final.jpg" }))
      .toBe("final.jpg");
  });

  // The common case: no overlays configured, so nothing was composited.
  it("falls back to the clean image when composited_url is empty", () => {
    expect(publishedImageUrl({ public_url: "clean.jpg", composited_url: "" }))
      .toBe("clean.jpg");
  });

  it("returns empty when neither exists, rather than undefined", () => {
    expect(publishedImageUrl({ public_url: "", composited_url: "" })).toBe("");
  });
});
