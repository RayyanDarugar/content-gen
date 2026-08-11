import { describe, it, expect } from "vitest";
import { describeResult } from "@/app/(app)/generate/generate-form";

describe("describeResult", () => {
  it("names the two loss paths separately", () => {
    const s = describeResult({ inserted: 4, rejectedByFilter: 3, droppedForShape: 1 });
    expect(s).toContain("3 rejected by the quality filter");
    expect(s).toContain("1 malformed");
  });

  it("omits a loss path that lost nothing", () => {
    const s = describeResult({ inserted: 8, rejectedByFilter: 0, droppedForShape: 0 });
    expect(s).toBe("Inserted 8 ideas.");
  });

  it("warns when the filter itself failed and nothing was reviewed", () => {
    const s = describeResult({ inserted: 8, rejectedByFilter: 0, droppedForShape: 0, filterFailed: true });
    expect(s.toLowerCase()).toContain("without review");
  });

  it("does not warn on a healthy pass", () => {
    expect(describeResult({ inserted: 1, rejectedByFilter: 1, droppedForShape: 0 }))
      .not.toContain("without review");
  });

  it("agrees with the singular", () => {
    expect(describeResult({ inserted: 1 })).toBe("Inserted 1 idea.");
  });
});
