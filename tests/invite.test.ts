import { afterEach, describe, expect, it } from "vitest";
import { checkInviteCode } from "@/lib/auth/invite";

describe("checkInviteCode", () => {
  afterEach(() => { delete process.env.INVITE_CODE; });

  it("returns true for the exact code", () => {
    process.env.INVITE_CODE = "supercontent2026";
    expect(checkInviteCode("supercontent2026")).toBe(true);
  });
  it("returns false for a wrong code", () => {
    process.env.INVITE_CODE = "supercontent2026";
    expect(checkInviteCode("nope")).toBe(false);
    expect(checkInviteCode("supercontent2026 ")).toBe(false);
  });
  it("returns false when INVITE_CODE is unset (fail closed)", () => {
    expect(checkInviteCode("anything")).toBe(false);
  });
});
