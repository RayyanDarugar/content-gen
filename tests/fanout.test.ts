import { describe, it, expect } from "vitest";
import {
  shouldFanOut,
  slideIndexesToFanOut,
  isCarouselComplete,
  shouldRetryAnchor,
  succeededIndexesUnderCurrentAnchor,
  orphanedTaskFailureRow,
  currentAnchor,
} from "@/lib/athena/fanout";

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

describe("succeededIndexesUnderCurrentAnchor", () => {
  const row = (id: string, slideIndex: number, anchorId: string | null, created: string) => ({
    id, slide_index: slideIndex, anchor_generation_id: anchorId, created_at: created,
  });

  it("is empty when no slide-0 has ever succeeded", () => {
    expect(succeededIndexesUnderCurrentAnchor([])).toEqual([]);
  });

  it("includes every sibling anchored to the current anchor", () => {
    const rows = [
      row("anchor", 0, null, "2026-01-01T00:00:00Z"),
      row("s1", 1, "anchor", "2026-01-01T00:01:00Z"),
      row("s2", 2, "anchor", "2026-01-01T00:02:00Z"),
    ];
    expect(succeededIndexesUnderCurrentAnchor(rows).sort()).toEqual([0, 1, 2]);
  });

  it("excludes siblings anchored to a superseded anchor, even though they are the newest succeeded row for their slide", () => {
    // The regeneration case from spec §5.6: old anchor's siblings succeeded
    // long ago and are still the newest succeeded row for their own slide
    // index, but a fresh anchor now exists and its own siblings haven't
    // landed yet. Pairing the new anchor with the old anchor's leftovers is
    // exactly the silently-broken carousel the anchor scoping prevents.
    const rows = [
      row("anchorA", 0, null, "2026-01-01T00:00:00Z"),
      row("old-s1", 1, "anchorA", "2026-01-01T00:01:00Z"),
      row("old-s2", 2, "anchorA", "2026-01-01T00:02:00Z"),
      row("anchorB", 0, null, "2026-01-02T00:00:00Z"),
    ];
    expect(succeededIndexesUnderCurrentAnchor(rows)).toEqual([0]);
  });

  it("picks the newest slide-0 row as the current anchor when several have succeeded (retried anchor history)", () => {
    const rows = [
      row("anchorOld", 0, null, "2026-01-01T00:00:00Z"),
      row("anchorNew", 0, null, "2026-01-03T00:00:00Z"),
      row("s1-new", 1, "anchorNew", "2026-01-03T00:01:00Z"),
      row("s1-old", 1, "anchorOld", "2026-01-01T00:01:00Z"),
    ];
    expect(succeededIndexesUnderCurrentAnchor(rows).sort()).toEqual([0, 1]);
  });
});

describe("orphanedTaskFailureRow", () => {
  it("records the orphaned task id in the error column so the spend is traceable", () => {
    const row = orphanedTaskFailureRow(
      { user_id: "u1", idea_id: "i1", slide_index: 2, anchor_generation_id: "anchor1" },
      "kie-task-123",
      "duplicate key value",
    );
    expect(row).toEqual({
      user_id: "u1",
      idea_id: "i1",
      slide_index: 2,
      anchor_generation_id: "anchor1",
      status: "failed",
      error: "generation insert failed after Kie task kie-task-123 was already created: duplicate key value",
    });
  });

  it("preserves a null anchor_generation_id for an orphaned anchor submission", () => {
    const row = orphanedTaskFailureRow(
      { user_id: "u1", idea_id: "i1", slide_index: 0 },
      "kie-task-456",
      "insert failed",
    );
    expect(row.anchor_generation_id).toBeUndefined();
    expect(row.slide_index).toBe(0);
    expect(row.status).toBe("failed");
  });
});

describe("currentAnchor", () => {
  const r = (id: string, slide_index: number, status: string, created_at: string) =>
    ({ id, slide_index, status, created_at });

  it("returns the newest succeeded slide-0 row", () => {
    expect(currentAnchor([
      r("old", 0, "succeeded", "1"), r("new", 0, "succeeded", "2"),
    ])?.id).toBe("new");
  });

  it("ignores a newer anchor that hasn't succeeded", () => {
    expect(currentAnchor([
      r("ok", 0, "succeeded", "1"), r("pending", 0, "submitted", "2"),
    ])?.id).toBe("ok");
  });

  it("ignores non-anchor slides entirely", () => {
    expect(currentAnchor([
      r("s3", 3, "succeeded", "9"), r("a", 0, "succeeded", "1"),
    ])?.id).toBe("a");
  });

  it("returns null when no anchor has succeeded yet", () => {
    expect(currentAnchor([r("p", 0, "polling", "1"), r("f", 0, "failed", "2")])).toBeNull();
  });

  it("returns null for an empty set", () => {
    expect(currentAnchor([])).toBeNull();
  });
});
