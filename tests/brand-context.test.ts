import { describe, expect, it, vi } from "vitest";

const eqCalls: [string, string][] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: (column: string, value: string) => {
          eqCalls.push([column, value]);
          return {
            maybeSingle: async () => ({
              data: { business_name: "Athena", proof_points: ["p1"], colors: ["#fff"] },
            }),
          };
        },
      }),
    }),
  }),
}));

import { loadBrandContext } from "@/lib/athena/brand-context";

describe("loadBrandContext", () => {
  it("fills in every BrandContext field, defaulting missing ones", async () => {
    const brand = await loadBrandContext("brand-1");
    expect(brand.business_name).toBe("Athena");
    expect(brand.proof_points).toEqual(["p1"]);
    expect(brand.voice).toBe("");
    expect(brand.fonts).toEqual([]);
  });

  it("looks the brand up by its own id, not by the account", async () => {
    eqCalls.length = 0;
    await loadBrandContext("brand-1");
    expect(eqCalls).toEqual([["id", "brand-1"]]);
  });
});
