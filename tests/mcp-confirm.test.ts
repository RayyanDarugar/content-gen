import { describe, expect, it } from "vitest";
import { assertConfirmed } from "@/lib/mcp/confirm";

describe("assertConfirmed", () => {
  it("throws with the summary when confirm is missing or false", () => {
    expect(() => assertConfirmed({}, "delete category FOO")).toThrow(/delete category FOO/);
    expect(() => assertConfirmed({ confirm: false }, "delete category FOO")).toThrow();
  });
  it("does not throw when confirm is true", () => {
    expect(() => assertConfirmed({ confirm: true }, "delete category FOO")).not.toThrow();
  });
});
