import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/safe-next";

describe("safeNextPath", () => {
  it("accepts a relative path", () => {
    expect(safeNextPath("/auth/update-password")).toBe("/auth/update-password");
  });

  it("falls back when the param is missing", () => {
    expect(safeNextPath(null)).toBe("/ideas");
  });

  // The callback runs with a freshly minted session, so an open redirect here
  // hands an attacker an authenticated user on their own domain.
  it("rejects an absolute URL", () => {
    expect(safeNextPath("https://evil.test/steal")).toBe("/ideas");
  });

  it("rejects a protocol-relative URL", () => {
    expect(safeNextPath("//evil.test/steal")).toBe("/ideas");
  });

  it("rejects a path that does not start with a slash", () => {
    expect(safeNextPath("ideas")).toBe("/ideas");
  });

  it("rejects an empty string", () => {
    expect(safeNextPath("")).toBe("/ideas");
  });
});
