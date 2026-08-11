import { describe, expect, it } from "vitest";
import { resolveOverlaysForIdea, slideIndexesForRoles } from "@/lib/athena/overlay-slots";
import type { CategoryOverlay, IdeaOverlayFill, Slide } from "@/lib/types";

function ov(over: Partial<CategoryOverlay>): CategoryOverlay {
  return {
    id: "o1", user_id: "u1", category_id: "c1", name: "Logo",
    image_url: "https://x.test/logo.png", is_slot: false,
    roles: ["single"], corner: "bottom-right",
    margin_pct: 5, size_pct: 15, opacity: 100, sort_order: 0, active: true,
    shape: "none", border_width_pct: 0, border_color: "", tint: "none", tint_color: "", shadow: false,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function fill(overlayId: string, imageUrl: string): IdeaOverlayFill {
  return {
    id: `f-${overlayId}`, user_id: "u1", idea_id: "i1",
    overlay_id: overlayId, image_url: imageUrl,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("resolveOverlaysForIdea", () => {
  it("passes a fixed overlay through untouched", () => {
    const logo = ov({ id: "logo" });
    const { resolved, unfilled } = resolveOverlaysForIdea([logo], []);
    expect(resolved).toEqual([logo]);
    expect(unfilled).toEqual([]);
  });

  it("substitutes a filled slot's image so it composites like any overlay", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "" });
    const { resolved, unfilled } = resolveOverlaysForIdea([slot], [fill("speaker", "https://x.test/amara.jpg")]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].image_url).toBe("https://x.test/amara.jpg");
    expect(resolved[0].id).toBe("speaker");
    expect(unfilled).toEqual([]);
  });

  // The whole point of returning two lists: an unfilled slot must be reported,
  // not silently dropped, or a speaker promo ships with no speaker and nothing
  // on screen saying so.
  it("reports an unfilled slot and excludes it from compositing", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "" });
    const { resolved, unfilled } = resolveOverlaysForIdea([slot], []);
    expect(resolved).toEqual([]);
    expect(unfilled.map((o) => o.id)).toEqual(["speaker"]);
  });

  it("splits a mix of fixed, filled and unfilled correctly", () => {
    const list = [
      ov({ id: "logo" }),
      ov({ id: "speaker", is_slot: true, image_url: "" }),
      ov({ id: "sponsor", is_slot: true, image_url: "" }),
    ];
    const { resolved, unfilled } = resolveOverlaysForIdea(list, [fill("speaker", "https://x.test/a.jpg")]);
    expect(resolved.map((o) => o.id)).toEqual(["logo", "speaker"]);
    expect(unfilled.map((o) => o.id)).toEqual(["sponsor"]);
  });

  // An inactive slot cannot composite anyway, so badging it as unfilled would
  // be noise the user cannot act on.
  it("does not report an inactive unfilled slot", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "", active: false });
    const { resolved, unfilled } = resolveOverlaysForIdea([slot], []);
    expect(resolved).toEqual([]);
    expect(unfilled).toEqual([]);
  });

  it("ignores a fill whose overlay is not in the list", () => {
    const logo = ov({ id: "logo" });
    const { resolved } = resolveOverlaysForIdea([logo], [fill("deleted-slot", "https://x.test/ghost.jpg")]);
    expect(resolved).toEqual([logo]);
  });

  it("treats a fill with an empty image_url as no fill at all", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "" });
    const { resolved, unfilled } = resolveOverlaysForIdea([slot], [fill("speaker", "")]);
    expect(resolved).toEqual([]);
    expect(unfilled.map((o) => o.id)).toEqual(["speaker"]);
  });

  it("does not mutate the overlays it was given", () => {
    const slot = ov({ id: "speaker", is_slot: true, image_url: "" });
    resolveOverlaysForIdea([slot], [fill("speaker", "https://x.test/a.jpg")]);
    expect(slot.image_url).toBe("");
  });
});

describe("slideIndexesForRoles", () => {
  const slides: Slide[] = [
    { role: "hook", text: "", visual: "" },
    { role: "beat", text: "", visual: "" },
    { role: "beat", text: "", visual: "" },
    { role: "payoff", text: "", visual: "" },
  ];

  it("finds the one slide a payoff-only slot touches", () => {
    expect(slideIndexesForRoles(slides, ["payoff"])).toEqual([3]);
  });

  it("finds every slide when a slot targets several roles", () => {
    expect(slideIndexesForRoles(slides, ["hook", "beat"])).toEqual([0, 1, 2]);
  });

  it("returns nothing when no slide carries the role", () => {
    expect(slideIndexesForRoles(slides, ["single"])).toEqual([]);
  });

  it("handles an idea with no slides", () => {
    expect(slideIndexesForRoles([], ["hook"])).toEqual([]);
  });
});
