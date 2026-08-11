import { describe, expect, it } from "vitest";
import { computePlacement } from "@/lib/athena/overlay-placement";

// 4:5 — this app's default aspect ratio.
const BASE = { width: 1000, height: 1250 };
const SQUARE = { width: 100, height: 100 };

describe("computePlacement", () => {
  it("sizes the overlay from the base's WIDTH, preserving its aspect ratio", () => {
    const p = computePlacement(BASE, { width: 200, height: 100 }, {
      corner: "top-left", margin_pct: 0, size_pct: 20,
    });
    expect(p.width).toBe(200);   // 20% of 1000
    expect(p.height).toBe(100);  // half of width, matching the 2:1 overlay
  });

  it("places top-left at the margin", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "top-left", margin_pct: 5, size_pct: 10 });
    expect({ left: p.left, top: p.top }).toEqual({ left: 50, top: 62 }); // 5% of 1000 / of 1250
  });

  it("places top-right against the right edge", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "top-right", margin_pct: 5, size_pct: 10 });
    expect(p.left).toBe(1000 - 100 - 50);
    expect(p.top).toBe(62);
  });

  it("places bottom-left against the bottom edge", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "bottom-left", margin_pct: 5, size_pct: 10 });
    expect(p.left).toBe(50);
    expect(p.top).toBe(1250 - 100 - 62);
  });

  it("places bottom-right against both far edges", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "bottom-right", margin_pct: 5, size_pct: 10 });
    expect(p.left).toBe(1000 - 100 - 50);
    expect(p.top).toBe(1250 - 100 - 62);
  });

  it("centres regardless of margin", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "center", margin_pct: 20, size_pct: 10 });
    expect(p.left).toBe(450);
    expect(p.top).toBe(575);
  });

  it("puts the overlay flush against the edge at margin 0", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "bottom-right", margin_pct: 0, size_pct: 10 });
    expect(p.left).toBe(900);
    expect(p.top).toBe(1150);
  });

  // sharp throws if a composite layer falls outside the base image, which a
  // badly configured overlay can cause. Clamping means one bad logo cannot
  // fail an entire ingest.
  it("clamps an overlay too large for its margin back inside the base", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "bottom-right", margin_pct: 40, size_pct: 100 });
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.left + p.width).toBeLessThanOrEqual(BASE.width);
    expect(p.top + p.height).toBeLessThanOrEqual(BASE.height);
  });

  it("never produces a zero-width layer", () => {
    const p = computePlacement(BASE, SQUARE, { corner: "center", margin_pct: 0, size_pct: 0.01 });
    expect(p.width).toBeGreaterThanOrEqual(1);
    expect(p.height).toBeGreaterThanOrEqual(1);
  });
});
