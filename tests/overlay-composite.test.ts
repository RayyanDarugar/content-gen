import { describe, expect, it } from "vitest";
import { overlaysForRole } from "@/lib/athena/overlay-composite";
import type { CategoryOverlay } from "@/lib/types";

function ov(over: Partial<CategoryOverlay>): CategoryOverlay {
  return {
    id: "o1", user_id: "u1", category_id: "c1", name: "Logo",
    image_url: "https://example.test/logo.png", is_slot: false,
    roles: ["single"], corner: "bottom-right",
    margin_pct: 5, size_pct: 15, opacity: 100, sort_order: 0, active: true,
    shape: "none", border_width_pct: 0, border_color: "", tint: "none", tint_color: "", shadow: false,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("overlaysForRole", () => {
  it("keeps only overlays targeting the slide's role", () => {
    const list = [ov({ id: "a", roles: ["hook"] }), ov({ id: "b", roles: ["payoff"] })];
    expect(overlaysForRole(list, "payoff").map((o) => o.id)).toEqual(["b"]);
  });

  it("keeps an overlay that targets several roles", () => {
    const list = [ov({ id: "a", roles: ["hook", "payoff"] })];
    expect(overlaysForRole(list, "hook").map((o) => o.id)).toEqual(["a"]);
    expect(overlaysForRole(list, "payoff").map((o) => o.id)).toEqual(["a"]);
  });

  it("drops inactive overlays even when the role matches", () => {
    const list = [ov({ id: "a", roles: ["single"], active: false })];
    expect(overlaysForRole(list, "single")).toEqual([]);
  });

  // Several overlays on one slide — a logo AND a QR code — stack in sort_order.
  it("orders matches by sort_order, lowest first", () => {
    const list = [
      ov({ id: "qr", roles: ["payoff"], sort_order: 2 }),
      ov({ id: "logo", roles: ["payoff"], sort_order: 1 }),
    ];
    expect(overlaysForRole(list, "payoff").map((o) => o.id)).toEqual(["logo", "qr"]);
  });

  it("returns empty for a role with no overlays — the common case today", () => {
    expect(overlaysForRole([ov({ roles: ["hook"] })], "beat")).toEqual([]);
  });

  it("does not mutate the input array's order", () => {
    const list = [ov({ id: "b", roles: ["single"], sort_order: 2 }), ov({ id: "a", roles: ["single"], sort_order: 1 })];
    overlaysForRole(list, "single");
    expect(list.map((o) => o.id)).toEqual(["b", "a"]);
  });
});
