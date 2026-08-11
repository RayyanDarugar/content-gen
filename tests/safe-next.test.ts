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

  // new URL() normalizes a leading backslash for special schemes, so this
  // resolves to https://evil.test/ despite starting with a single slash.
  it("rejects a backslash-prefixed host", () => {
    expect(safeNextPath("/\\evil.test")).toBe("/ideas");
  });

  it("rejects a mixed slash-backslash host", () => {
    expect(safeNextPath("/\\/evil.test")).toBe("/ideas");
  });

  // WHATWG parsing strips embedded tab/CR/LF before resolving.
  it("rejects a host hidden behind an embedded tab", () => {
    expect(safeNextPath("/\t/evil.test")).toBe("/ideas");
  });

  it("keeps a query string and hash on an accepted path", () => {
    expect(safeNextPath("/auth/update-password?a=1#b")).toBe("/auth/update-password?a=1#b");
  });

  // The origin check passes (the sentinel is intact) but the canonical form
  // is itself protocol-relative, and that is what gets re-parsed downstream.
  it("rejects an input that canonicalizes into a protocol-relative path", () => {
    expect(safeNextPath("/.//evil.test")).toBe("/ideas");
    expect(safeNextPath("/..//evil.test")).toBe("/ideas");
    expect(safeNextPath("/./\\/evil.test")).toBe("/ideas");
  });

  it("rejects a sentinel-host payload that canonicalizes off-origin", () => {
    expect(safeNextPath("//safe-next.invalid//evil.test")).toBe("/ideas");
  });
});
