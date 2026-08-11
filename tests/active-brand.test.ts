import { describe, expect, it } from "vitest";
import { selectActiveBrand } from "@/lib/auth/active-brand";
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

const superset = brand({ id: "b1", is_default: true });
const rewire = brand({ id: "b2", created_at: "2026-06-01T00:00:00Z" });

describe("selectActiveBrand", () => {
  it("returns the brand the cookie names", () => {
    expect(selectActiveBrand([superset, rewire], "b2")?.id).toBe("b2");
  });

  it("falls back to the default brand when there is no cookie", () => {
    expect(selectActiveBrand([superset, rewire], undefined)?.id).toBe("b1");
  });

  it("falls back to the default brand when the cookie is stale", () => {
    expect(selectActiveBrand([superset, rewire], "deleted-brand")?.id).toBe("b1");
  });

  // The isolation property: another tenant's brand id is not in this user's
  // list, so it cannot be selected — no explicit ownership check to forget.
  it("ignores a cookie naming another account's brand", () => {
    expect(selectActiveBrand([superset], "someone-elses-brand")?.id).toBe("b1");
  });

  it("returns null when the account has no brands at all", () => {
    expect(selectActiveBrand([], "b1")).toBeNull();
  });
});
