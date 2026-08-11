import { describe, expect, it } from "vitest";
import { scopeToCategoryKeys } from "@/lib/scope";

const items = [
  { id: "1", category_key: "SUPERSET_TIPS" },
  { id: "2", category_key: "REWIRE_NEWS" },
  { id: "3", category_key: "SUPERSET_TIPS" },
];

describe("scopeToCategoryKeys", () => {
  it("keeps only items whose category belongs to the brand", () => {
    expect(scopeToCategoryKeys(items, ["SUPERSET_TIPS"]).map((i) => i.id)).toEqual(["1", "3"]);
  });

  // The dangerous case: an empty key list must mean "this brand has nothing",
  // never "no filter applied".
  it("returns nothing when the brand has no categories", () => {
    expect(scopeToCategoryKeys(items, [])).toEqual([]);
  });
});
