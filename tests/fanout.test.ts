import { describe, it, expect } from "vitest";
import { shouldFanOut, slideIndexesToFanOut, isCarouselComplete, shouldRetryAnchor } from "@/lib/athena/fanout";

describe("shouldFanOut", () => {
  it("fans out a multi-slide carousel with no siblings yet", () => {
    expect(shouldFanOut(5, 0)).toBe(true);
  });

  it("does not fan out a single-slide post", () => {
    expect(shouldFanOut(1, 0)).toBe(false);
  });

  it("does not fan out twice for the same anchor", () => {
    expect(shouldFanOut(5, 4)).toBe(false);
  });

  it("does not fan out when even one sibling exists (partial prior run)", () => {
    expect(shouldFanOut(5, 1)).toBe(false);
  });
});

describe("slideIndexesToFanOut", () => {
  it("returns every index except the anchor", () => {
    expect(slideIndexesToFanOut(5)).toEqual([1, 2, 3, 4]);
  });

  it("returns nothing for a single-slide post", () => {
    expect(slideIndexesToFanOut(1)).toEqual([]);
  });
});

describe("isCarouselComplete", () => {
  it("is complete when every index succeeded", () => {
    expect(isCarouselComplete(5, [0, 1, 2, 3, 4])).toBe(true);
  });

  it("is incomplete when one is missing", () => {
    expect(isCarouselComplete(5, [0, 1, 2, 4])).toBe(false);
  });

  it("ignores duplicates from retries", () => {
    expect(isCarouselComplete(3, [0, 0, 1, 2, 2])).toBe(true);
  });

  it("is complete for a single slide", () => {
    expect(isCarouselComplete(1, [0])).toBe(true);
  });

  it("is incomplete with no successes", () => {
    expect(isCarouselComplete(3, [])).toBe(false);
  });
});

describe("shouldRetryAnchor", () => {
  it("retries a failed first attempt", () => {
    expect(shouldRetryAnchor(1, false)).toBe(true);
  });

  it("retries a failed second attempt", () => {
    expect(shouldRetryAnchor(2, false)).toBe(true);
  });

  it("gives up after three attempts", () => {
    expect(shouldRetryAnchor(3, false)).toBe(false);
  });

  it("never retries once an anchor has succeeded", () => {
    expect(shouldRetryAnchor(1, true)).toBe(false);
  });
});
