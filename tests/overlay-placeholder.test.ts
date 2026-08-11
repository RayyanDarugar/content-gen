import { describe, expect, it } from "vitest";
import { placeholderFillOverlays } from "@/lib/athena/overlay-placeholder";
import type { CategoryOverlay } from "@/lib/types";

function ov(over: Partial<CategoryOverlay>): CategoryOverlay {
  return {
    id: "o1", user_id: "u1", category_id: "c1", name: "Logo",
    image_url: "https://x.test/logo.png", is_slot: false,
    roles: ["single"], corner: "bottom-right",
    margin_pct: 5, size_pct: 15, opacity: 100, sort_order: 0, active: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("placeholderFillOverlays", () => {
  it("leaves a fixed overlay's image alone", async () => {
    const out = await placeholderFillOverlays([ov({ id: "logo" })]);
    expect(out[0].image_url).toBe("https://x.test/logo.png");
  });

  it("gives a slot a data-URI placeholder so it composites like any overlay", async () => {
    const out = await placeholderFillOverlays([ov({ id: "slot", is_slot: true, image_url: "" })]);
    expect(out).toHaveLength(1);
    expect(out[0].image_url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("does not mutate the overlays it was given", async () => {
    const slot = ov({ id: "slot", is_slot: true, image_url: "" });
    await placeholderFillOverlays([slot]);
    expect(slot.image_url).toBe("");
  });
});
