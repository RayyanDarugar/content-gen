import type { CategoryOverlay } from "@/lib/types";

// Pure, and no server-only import: the ordering and the arithmetic are the
// parts of B3 worth testing, and they are only testable because no sharp call
// sits beside them — the same separation that makes computePlacement testable.

// Derived from the layer's own width so a shadow looks right on a 15% logo
// and a 35% headshot alike, and across this app's 4:5 and 1:1 canvases.
const SHADOW_OFFSET_PCT = 2;
const SHADOW_BLUR_PCT = 3;
// Of the SHORTER side — 12% of a wide layer's width would exceed half its
// height and produce a malformed shape.
const ROUNDED_RADIUS_PCT = 12;

export interface TreatmentGeometry {
  borderPx: number;
  shadowOffsetPx: number;
  shadowBlurPx: number;
  cornerRadiusPx: number;
}

export function treatmentGeometry(
  box: { width: number; height: number },
  o: Pick<CategoryOverlay, "border_width_pct" | "shape">,
): TreatmentGeometry {
  const shorter = Math.min(box.width, box.height);

  // A border thicker than half the shorter side consumes the layer entirely
  // and inverts into a solid rectangle. Clamp rather than render that.
  const maxBorder = Math.max(0, Math.floor((shorter - 1) / 2));
  const borderPx = Math.min(
    Math.max(0, Math.round((box.width * o.border_width_pct) / 100)),
    maxBorder,
  );

  return {
    borderPx,
    shadowOffsetPx: Math.max(1, Math.round((box.width * SHADOW_OFFSET_PCT) / 100)),
    shadowBlurPx: Math.max(1, Math.round((box.width * SHADOW_BLUR_PCT) / 100)),
    cornerRadiusPx:
      o.shape === "rounded"
        ? Math.max(1, Math.round((shorter * ROUNDED_RADIUS_PCT) / 100))
        : 0,
  };
}

export type TreatmentStage = "resize" | "tint" | "mask" | "border" | "opacity";

// The stage order IS the design (spec §4), and each step is wrong in a
// specific, invisible-in-isolation way if moved. Exposing it as a list lets a
// test assert the ordering without rendering anything.
export function treatmentStages(
  o: Pick<CategoryOverlay, "tint" | "shape" | "border_width_pct" | "opacity">,
): TreatmentStage[] {
  const stages: TreatmentStage[] = ["resize"];
  if (o.tint !== "none") stages.push("tint");
  if (o.shape !== "none") stages.push("mask");
  if (o.border_width_pct > 0) stages.push("border");
  if (o.opacity < 100) stages.push("opacity");
  return stages;
}
