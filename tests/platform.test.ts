import { describe, expect, it } from "vitest";
import { normalizeService, platformCharLimit } from "@/lib/platform";

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
