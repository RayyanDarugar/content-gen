import type { OverlayCorner } from "@/lib/types";

export interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Pure, and deliberately separate from the sharp module: placement is the
// part worth testing, and it can only be tested if no image I/O sits next to
// it. Percentages are resolved against the base image's REAL pixel
// dimensions, so one configuration works across 4:5 and 1:1.
//
// size_pct keys off width only; height follows from the overlay's own aspect
// ratio, so a wide logo and a square QR code both stay undistorted.
// margin_pct resolves against each axis separately, so a 5% inset looks even
// on a non-square canvas. Margins are floored (not rounded) so they never
// claim a fractional pixel of space they weren't given.
export function computePlacement(
  base: { width: number; height: number },
  overlay: { width: number; height: number },
  o: { corner: OverlayCorner; margin_pct: number; size_pct: number },
): Placement {
  let width = Math.max(1, Math.round((base.width * o.size_pct) / 100));
  let height = Math.max(1, Math.round(width * (overlay.height / overlay.width)));

  // Shrink to fit, preserving aspect. size_pct constrains WIDTH only, so any
  // asset taller than the base's own aspect ratio overflows vertically at
  // ordinary percentages — a 1:3 overlay at size_pct 42 on a 1000x1250 canvas
  // derives to 420x1260. sharp throws on an out-of-bounds layer, which would
  // lose an image that already generated successfully.
  // Floor, not round: rounding could push a dimension back over the edge.
  if (width > base.width || height > base.height) {
    const scale = Math.min(base.width / width, base.height / height);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }

  const mx = Math.floor((base.width * o.margin_pct) / 100);
  const my = Math.floor((base.height * o.margin_pct) / 100);

  let left: number;
  let top: number;
  switch (o.corner) {
    case "top-left":
      left = mx; top = my; break;
    case "top-right":
      left = base.width - width - mx; top = my; break;
    case "bottom-left":
      left = mx; top = base.height - height - my; break;
    case "bottom-right":
      left = base.width - width - mx; top = base.height - height - my; break;
    case "center":
      left = Math.round((base.width - width) / 2);
      top = Math.round((base.height - height) / 2);
      break;
  }

  // sharp throws if a composite layer extends past the base, which an
  // oversized size_pct or a large margin can produce. Clamping keeps one
  // badly configured overlay from failing a whole ingest.
  return {
    width,
    height,
    left: Math.min(Math.max(0, left), Math.max(0, base.width - width)),
    top: Math.min(Math.max(0, top), Math.max(0, base.height - height)),
  };
}
