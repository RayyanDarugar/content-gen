import { describe, expect, it, vi, beforeEach } from "vitest";

// What each table lookup should return this test. Set per case.
const rows: Record<string, unknown> = {};
const writes: { op: string; payload: unknown }[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from(table: string) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        maybeSingle: async () => ({ data: rows[table] ?? null }),
        upsert(payload: unknown) {
          writes.push({ op: `upsert:${table}`, payload });
          return { then: (r: (v: { error: null }) => void) => r({ error: null }) };
        },
        delete() {
          writes.push({ op: `delete:${table}`, payload: null });
          return chain;
        },
        then(resolve: (v: { error: null }) => void) { resolve({ error: null }); },
      };
      return chain;
    },
  }),
}));

import { setOverlayFillForUser } from "@/lib/overlay-fill-mutations";

beforeEach(() => {
  writes.length = 0;
  rows.ideas = { id: "i1" };
  rows.category_overlays = { id: "o1", is_slot: true };
});

describe("setOverlayFillForUser", () => {
  it("writes the fill when the idea and slot both belong to the caller", async () => {
    await setOverlayFillForUser("u1", "i1", "o1", "https://x.test/a.jpg");
    expect(writes.map((w) => w.op)).toEqual(["upsert:idea_overlay_fills"]);
    expect(writes[0].payload).toEqual({
      user_id: "u1", idea_id: "i1", overlay_id: "o1", image_url: "https://x.test/a.jpg",
    });
  });

  // Both ids arrive from the client, and the admin client bypasses RLS.
  it("refuses an idea the caller does not own", async () => {
    rows.ideas = null;
    await expect(setOverlayFillForUser("u1", "other", "o1", "https://x.test/a.jpg"))
      .rejects.toThrow(/unknown idea/);
    expect(writes).toEqual([]);
  });

  it("refuses an overlay the caller does not own", async () => {
    rows.category_overlays = null;
    await expect(setOverlayFillForUser("u1", "i1", "other", "https://x.test/a.jpg"))
      .rejects.toThrow(/unknown overlay/);
    expect(writes).toEqual([]);
  });

  // Filling a fixed overlay would silently override the logo configured on the
  // category for this one idea — a different feature, quietly.
  it("refuses an overlay that is not a slot", async () => {
    rows.category_overlays = { id: "o1", is_slot: false };
    await expect(setOverlayFillForUser("u1", "i1", "o1", "https://x.test/a.jpg"))
      .rejects.toThrow(/not a slot/);
    expect(writes).toEqual([]);
  });

  it("refuses a blank image url", async () => {
    await expect(setOverlayFillForUser("u1", "i1", "o1", "   "))
      .rejects.toThrow(/image/i);
    expect(writes).toEqual([]);
  });
});
