import { describe, expect, it } from "vitest";
import { treatmentGeometry, treatmentStages } from "@/lib/athena/overlay-treatments";

describe("treatmentGeometry", () => {
  it("derives the border from a percentage of the layer's width", () => {
    const g = treatmentGeometry({ width: 400, height: 400 }, { border_width_pct: 5, shape: "none" });
    expect(g.borderPx).toBe(20);
  });

  it("is zero when no border is configured", () => {
    const g = treatmentGeometry({ width: 400, height: 400 }, { border_width_pct: 0, shape: "none" });
    expect(g.borderPx).toBe(0);
  });

  // A border thicker than half the shorter side would consume the layer and
  // invert into a solid rectangle.
  it("clamps a border that would consume the layer", () => {
    const g = treatmentGeometry({ width: 100, height: 40 }, { border_width_pct: 25, shape: "none" });
    expect(g.borderPx * 2).toBeLessThan(40);
  });

  it("scales the shadow with the layer, not with a fixed pixel size", () => {
    const small = treatmentGeometry({ width: 100, height: 100 }, { border_width_pct: 0, shape: "none" });
    const large = treatmentGeometry({ width: 1000, height: 1000 }, { border_width_pct: 0, shape: "none" });
    expect(large.shadowOffsetPx).toBeGreaterThan(small.shadowOffsetPx);
    expect(large.shadowBlurPx).toBeGreaterThan(small.shadowBlurPx);
  });

  // Keyed off WIDTH, the blur a wide layer got was larger than its whole
  // height — and the builder insets the silhouette by that blur on all four
  // sides, so a 432x22 wordmark's shadow decayed to invisible and then snapped
  // back to a hard-edged bar. Same shorter-side rule as the corner radius.
  it("derives the shadow offset and blur from the shorter side", () => {
    const wide = treatmentGeometry({ width: 1000, height: 100 }, { border_width_pct: 0, shape: "none" });
    const square = treatmentGeometry({ width: 100, height: 100 }, { border_width_pct: 0, shape: "none" });
    expect(wide.shadowBlurPx).toBe(square.shadowBlurPx);
    expect(wide.shadowOffsetPx).toBe(square.shadowOffsetPx);
  });

  // The builder's inset (height - 2 * blur) must stay positive, or it takes
  // the degenerate branch that renders a uniform hard-edged bar.
  it("leaves a wide layer room to inset by the blur on both axes", () => {
    for (const height of [1000, 300, 100, 60, 22, 10, 3]) {
      const g = treatmentGeometry({ width: 1080, height }, { border_width_pct: 0, shape: "none" });
      expect(height - 2 * g.shadowBlurPx).toBeGreaterThanOrEqual(1);
    }
  });

  it("never produces a zero shadow offset or blur", () => {
    const g = treatmentGeometry({ width: 10, height: 10 }, { border_width_pct: 0, shape: "none" });
    expect(g.shadowOffsetPx).toBeGreaterThanOrEqual(1);
    expect(g.shadowBlurPx).toBeGreaterThanOrEqual(1);
  });

  it("gives a corner radius only for the rounded shape", () => {
    const box = { width: 400, height: 200 };
    expect(treatmentGeometry(box, { border_width_pct: 0, shape: "rounded" }).cornerRadiusPx).toBeGreaterThan(0);
    expect(treatmentGeometry(box, { border_width_pct: 0, shape: "circle" }).cornerRadiusPx).toBe(0);
    expect(treatmentGeometry(box, { border_width_pct: 0, shape: "none" }).cornerRadiusPx).toBe(0);
  });

  // The radius keys off the SHORTER side: 12% of a wide layer's width would
  // exceed half its height and produce a malformed shape.
  it("derives the corner radius from the shorter side", () => {
    const wide = treatmentGeometry({ width: 1000, height: 100 }, { border_width_pct: 0, shape: "rounded" });
    expect(wide.cornerRadiusPx * 2).toBeLessThanOrEqual(100);
  });
});

describe("treatmentStages", () => {
  const plain = { tint: "none" as const, shape: "none" as const, border_width_pct: 0, opacity: 100 };

  it("is resize alone for an untreated overlay", () => {
    expect(treatmentStages(plain)).toEqual(["resize"]);
  });

  // Mask before tint leaves the mask's antialiased edge pixels untinted — a
  // faint untreated halo around the shape.
  it("tints before masking", () => {
    const s = treatmentStages({ ...plain, tint: "grayscale", shape: "circle" });
    expect(s.indexOf("tint")).toBeLessThan(s.indexOf("mask"));
  });

  // Bordering before masking traces the original rectangle, so the mask then
  // cuts the border's corners off.
  it("borders after masking", () => {
    const s = treatmentStages({ ...plain, shape: "circle", border_width_pct: 4 });
    expect(s.indexOf("border")).toBeGreaterThan(s.indexOf("mask"));
  });

  it("applies opacity last of all", () => {
    const s = treatmentStages({ tint: "color", shape: "rounded", border_width_pct: 4, opacity: 50 });
    expect(s).toEqual(["resize", "tint", "mask", "border", "opacity"]);
  });

  it("omits stages the overlay does not configure", () => {
    expect(treatmentStages({ ...plain, tint: "grayscale" })).toEqual(["resize", "tint"]);
    expect(treatmentStages({ ...plain, opacity: 40 })).toEqual(["resize", "opacity"]);
  });

  it("always starts with resize", () => {
    expect(treatmentStages({ tint: "color", shape: "circle", border_width_pct: 9, opacity: 10 })[0]).toBe("resize");
  });
});
