import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { business_name: "Athena", proof_points: ["p1"], colors: ["#fff"] },
          }),
        }),
      }),
    }),
  }),
}));

import { loadBrandContext } from "@/lib/athena/brand-context";

describe("loadBrandContext", () => {
  it("fills in every BrandContext field, defaulting missing ones", async () => {
    const brand = await loadBrandContext("user-1");
    expect(brand.business_name).toBe("Athena");
    expect(brand.proof_points).toEqual(["p1"]);
    expect(brand.voice).toBe("");
    expect(brand.fonts).toEqual([]);
  });
});
