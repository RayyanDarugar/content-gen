import { describe, expect, it } from "vitest";
import { buildQueueRows } from "@/lib/athena/queue";

const g = (id: string, slide_index: number, anchor: string | null, created_at: string) =>
  ({ id, idea_id: "x", slide_index, anchor_generation_id: anchor, status: "succeeded", created_at });

const idea = (id: string, created_at: string, slideCount: number, generations: ReturnType<typeof g>[]) => ({
  id, category_key: "CAT", concept: `concept ${id}`, post_text: "copy",
  slides: Array.from({ length: slideCount }, () => ({})), created_at, generations,
});

const urls = new Map([["a", "https://x/a.png"], ["b", "https://x/b.png"]]);

describe("buildQueueRows", () => {
  it("reports ready and total counts for a partial carousel", () => {
    const rows = buildQueueRows([idea("i1", "2026-01-02", 3, [g("a", 0, null, "2026-01-01"), g("b", 1, "a", "2026-01-02")])], urls);
    expect(rows[0].readyCount).toBe(2);
    expect(rows[0].slideCount).toBe(3);
    expect(rows[0].thumbnailUrl).toBe("https://x/a.png");
  });
  it("omits ideas with no succeeded slides", () => {
    expect(buildQueueRows([idea("i2", "2026-01-02", 2, [])], urls)).toEqual([]);
  });
  it("orders newest idea first", () => {
    const rows = buildQueueRows([
      idea("old", "2026-01-01", 1, [g("a", 0, null, "2026-01-01")]),
      idea("new", "2026-02-01", 1, [g("a", 0, null, "2026-01-01")]),
    ], urls);
    expect(rows.map((r) => r.ideaId)).toEqual(["new", "old"]);
  });
  it("treats an idea with no declared slides as one slide", () => {
    const rows = buildQueueRows([idea("i3", "2026-01-02", 0, [g("a", 0, null, "2026-01-01")])], urls);
    expect(rows[0].slideCount).toBe(1);
    expect(rows[0].readyCount).toBe(1);
  });
});
