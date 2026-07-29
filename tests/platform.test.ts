import { describe, expect, it } from "vitest";
import { normalizeService, platformCharLimit, mediaForPlatform } from "@/lib/platform";

describe("normalizeService", () => {
  it("maps the four known platforms", () => {
    expect(normalizeService("tiktok")).toBe("tiktok");
    expect(normalizeService("instagram")).toBe("instagram");
    expect(normalizeService("linkedin")).toBe("linkedin");
  });
  it("maps both twitter and x to x, case-insensitively", () => {
    expect(normalizeService("twitter")).toBe("x");
    expect(normalizeService("X")).toBe("x");
    expect(normalizeService("  Twitter  ")).toBe("x");
  });
  it("falls back to generic for unknown and empty", () => {
    expect(normalizeService("mastodon")).toBe("generic");
    expect(normalizeService("")).toBe("generic");
  });
});

describe("platformCharLimit", () => {
  it("is 280 for x and null elsewhere", () => {
    expect(platformCharLimit("x")).toBe(280);
    expect(platformCharLimit("linkedin")).toBeNull();
    expect(platformCharLimit("generic")).toBeNull();
  });
});

describe("mediaForPlatform", () => {
  const five = ["a", "b", "c", "d", "e"];
  it("truncates X to its 4-image mosaic limit", () => {
    expect(mediaForPlatform(five, "x")).toEqual(["a", "b", "c", "d"]);
  });
  it("passes every other platform through unchanged", () => {
    expect(mediaForPlatform(five, "tiktok")).toEqual(five);
    expect(mediaForPlatform(five, "instagram")).toEqual(five);
    expect(mediaForPlatform(five, "linkedin")).toEqual(five);
    expect(mediaForPlatform(five, "generic")).toEqual(five);
  });
  it("leaves short and empty lists alone on X", () => {
    expect(mediaForPlatform(["a", "b"], "x")).toEqual(["a", "b"]);
    expect(mediaForPlatform([], "x")).toEqual([]);
  });
  it("returns a new array rather than mutating its input", () => {
    const input = [...five];
    expect(mediaForPlatform(input, "x")).not.toBe(input);
    expect(input).toHaveLength(5);
  });
});
