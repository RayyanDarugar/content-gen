import "server-only";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { computePlacement } from "@/lib/athena/overlay-placement";
import { buildOverlayLayer } from "@/lib/athena/overlay-layer";
import { treatmentGeometry } from "@/lib/athena/overlay-treatments";
import type { CategoryOverlay, Slide } from "@/lib/types";

// Pure — exported separately so the selection rule is testable without any
// image I/O. Sorts a copy: callers pass arrays they still own.
export function overlaysForRole(
  overlays: CategoryOverlay[],
  role: Slide["role"],
): CategoryOverlay[] {
  return overlays
    .filter((o) => o.active && o.roles.includes(role))
    .sort((a, b) => a.sort_order - b.sort_order);
}

// Returns null when nothing was composited, so the caller can skip a second
// Cloudinary upload entirely — which is every category today.
//
// A failing overlay is skipped, never thrown: the generation it belongs to
// has already succeeded, and losing a finished image because a logo URL
// 404'd would be a far worse outcome than a post missing its logo.
export async function compositeOverlays(
  base: Buffer,
  overlays: CategoryOverlay[],
  role: Slide["role"],
): Promise<Buffer | null> {
  const layers = overlaysForRole(overlays, role);
  if (layers.length === 0) return null;

  // Guarded like every other sharp/network call here: compositeOverlays must
  // never throw. By the time it runs, the generation's image has already
  // succeeded and been stored — losing it because the buffer was unparseable
  // would be far worse than a post missing its logo.
  let meta;
  try {
    meta = await sharp(base).metadata();
  } catch (e) {
    console.error("overlay compositing skipped — unreadable base image:", e);
    return null;
  }
  if (!meta.width || !meta.height) return null;

  let current = base;
  let composited = 0;

  for (const o of layers) {
    try {
      // app/api/jobs/poll/route.ts's cron loop runs every pending generation
      // of every tenant sequentially under one shared maxDuration = 120, and
      // undici's fetch has no default deadline — without this timeout, one
      // overlay host that accepts a connection and never responds would
      // stall past the function's budget and starve every generation queued
      // after it, not just this tenant's.
      const res = await fetch(o.image_url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = Buffer.from(await res.arrayBuffer());

      const om = await sharp(raw).metadata();
      if (!om.width || !om.height) throw new Error("overlay image has no dimensions");

      const p = computePlacement(
        { width: meta.width, height: meta.height },
        { width: om.width, height: om.height },
        o,
      );

      // The per-layer build (resize, treatments, opacity) lives in
      // lib/athena/overlay-layer.ts. This function stays an orchestrator:
      // fetch, place, build, composite.
      const { layer, shadow } = await buildOverlayLayer(raw, { width: p.width, height: p.height }, o);

      const parts: OverlayOptions[] = [];
      if (shadow) {
        // Clamped inside the base rather than expanding the canvas: sharp
        // throws when a composite layer falls outside, which is exactly the
        // failure computePlacement already had to be fixed for. An overlay
        // flush against the margin gets a slightly clipped shadow instead of
        // a failed ingest.
        const g = treatmentGeometry({ width: p.width, height: p.height }, o);
        parts.push({
          input: shadow,
          left: Math.min(Math.max(0, p.left + g.shadowOffsetPx), Math.max(0, meta.width - p.width)),
          top: Math.min(Math.max(0, p.top + g.shadowOffsetPx), Math.max(0, meta.height - p.height)),
        });
      }
      parts.push({ input: layer, left: p.left, top: p.top });

      current = await sharp(current)
        .composite(parts)
        // Match the clean image's encode (quality: 90) — sharp defaults JPEG
        // output to 80, so the published image would end up softer than the
        // one nobody sees.
        .jpeg({ quality: 90 })
        .toBuffer();
      composited++;
    } catch (e) {
      console.error(`overlay "${o.name}" (${o.id}) skipped:`, e);
    }
  }

  // Every layer failed — return null rather than uploading a byte-identical
  // copy of the clean image as though it were a finished one.
  return composited > 0 ? current : null;
}
