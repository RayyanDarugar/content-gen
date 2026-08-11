import { describe, expect, it } from "vitest";
import { pickDefaultBrand, resolveBrandByName } from "@/lib/brands";
import type { BrandProfile } from "@/lib/types";

function brand(over: Partial<BrandProfile>): BrandProfile {
  return {
    id: "b1", user_id: "u1", is_default: false, business_name: "Acme",
    business_description: "", audience: "", voice: "", avoid: "",
    proof_points: [], standing: [], colors: [], fonts: [], visual_notes: "",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("pickDefaultBrand", () => {
  it("returns null when the account has no brands", () => {
    expect(pickDefaultBrand([])).toBeNull();
  });

  it("prefers the row flagged is_default", () => {
    const brands = [
      brand({ id: "b1", created_at: "2026-01-01T00:00:00Z" }),
      brand({ id: "b2", is_default: true, created_at: "2026-05-01T00:00:00Z" }),
    ];
    expect(pickDefaultBrand(brands)?.id).toBe("b2");
  });

  it("falls back to the oldest brand when nothing is flagged", () => {
    const brands = [
      brand({ id: "newer", created_at: "2026-05-01T00:00:00Z" }),
      brand({ id: "older", created_at: "2026-01-01T00:00:00Z" }),
    ];
    expect(pickDefaultBrand(brands)?.id).toBe("older");
  });
});

describe("resolveBrandByName", () => {
  const superset = brand({ id: "b1", business_name: "super{set}" });
  const rewire = brand({ id: "b2", business_name: "Rewire" });

  it("throws when the account has no brands", () => {
    expect(() => resolveBrandByName([], undefined)).toThrow(/no brands yet/);
  });

  it("resolves without a name when there is exactly one brand", () => {
    expect(resolveBrandByName([superset], undefined).id).toBe("b1");
  });

  it("refuses to guess when several brands exist and no name is given", () => {
    expect(() => resolveBrandByName([superset, rewire], undefined))
      .toThrow(/super\{set\}, Rewire/);
  });

  it("treats a blank name as absent", () => {
    expect(() => resolveBrandByName([superset, rewire], "   "))
      .toThrow(/Pass brand explicitly/);
  });

  it("matches a name case-insensitively and ignoring surrounding space", () => {
    expect(resolveBrandByName([superset, rewire], "  rewire ").id).toBe("b2");
  });

  it("lists the available brands when the name matches nothing", () => {
    expect(() => resolveBrandByName([superset, rewire], "Kana"))
      .toThrow(/Available: super\{set\}, Rewire/);
  });
});
