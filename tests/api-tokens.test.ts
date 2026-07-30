import { describe, expect, it } from "vitest";
import { generateApiToken, hashToken } from "@/lib/auth/api-tokens";

describe("generateApiToken", () => {
  it("produces a token whose hash matches hashToken", () => {
    const { token, hash } = generateApiToken();
    expect(token.startsWith("cga_")).toBe(true);
    expect(hashToken(token)).toBe(hash);
  });

  it("produces different tokens on each call", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.token).not.toBe(b.token);
  });
});
