import "server-only";
import sharp from "sharp";
import { computePlacement } from "@/lib/athena/overlay-placement";
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

      let layer = sharp(raw).resize(p.width, p.height, { fit: "fill" }).ensureAlpha();
      if (o.opacity < 100) {
        // Scale the layer's alpha by compositing a uniform grey over it with
        // dest-in, which multiplies destination alpha by source alpha.
        layer = layer.composite([{
          input: {
            create: {
              width: p.width, height: p.height, channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: o.opacity / 100 },
            },
          },
          blend: "dest-in",
        }]);
      }

      const layerBuf = await layer.png().toBuffer();
      current = await sharp(current)
        .composite([{ input: layerBuf, left: p.left, top: p.top }])
        // Match the clean image's encode (quality: 90, app/api/jobs/poll/route.ts)
        // — without an explicit format call here, sharp defaults JPEG output
        // to quality 80, so the published image would end up softer than the
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
