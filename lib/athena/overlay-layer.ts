import "server-only";
import sharp from "sharp";
import { treatmentGeometry } from "@/lib/athena/overlay-treatments";
import type { CategoryOverlay } from "@/lib/types";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.trim().replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// The mask shape, as an SVG the size of the layer. White where the layer
// should survive; compositing it with dest-in multiplies the layer's alpha by
// this, so anything outside the shape becomes transparent.
function maskSvg(w: number, h: number, o: CategoryOverlay, radius: number): Buffer {
  const body =
    o.shape === "circle"
      ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#fff"/>`
      : `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/>`;
  return Buffer.from(`<svg width="${w}" height="${h}">${body}</svg>`);
}

// The border traces the MASK's shape, drawn inset by half its width so the
// stroke sits fully inside the layer rather than being clipped in half.
function borderSvg(w: number, h: number, o: CategoryOverlay, radius: number, px: number): Buffer {
  const i = px / 2;
  const body =
    o.shape === "circle"
      ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2 - i}" ry="${h / 2 - i}" fill="none" stroke="${o.border_color}" stroke-width="${px}"/>`
      : `<rect x="${i}" y="${i}" width="${w - px}" height="${h - px}" rx="${Math.max(0, radius - i)}" ry="${Math.max(0, radius - i)}" fill="none" stroke="${o.border_color}" stroke-width="${px}"/>`;
  return Buffer.from(`<svg width="${w}" height="${h}">${body}</svg>`);
}

// Applies treatments in the one order that is correct (spec §4):
// resize -> tint -> mask -> border -> opacity, with the shadow taken from the
// MASKED alpha so a circular photo casts a circular shadow.
//
// Returns the layer plus an optional shadow of identical dimensions. The
// shadow is deliberately NOT built on an expanded canvas: sharp throws when a
// composite layer falls outside the base, and the caller clamps this one
// inside instead.
export async function buildOverlayLayer(
  raw: Buffer,
  box: { width: number; height: number },
  o: CategoryOverlay,
): Promise<{ layer: Buffer; shadow: Buffer | null }> {
  const g = treatmentGeometry(box, o);
  const { width, height } = box;

  // resize
  let buf = await sharp(raw).resize(width, height, { fit: "fill" }).ensureAlpha().png().toBuffer();

  // tint — before the mask, or the mask's antialiased edge keeps untinted pixels
  if (o.tint === "grayscale") {
    buf = await sharp(buf).grayscale().png().toBuffer();
  } else if (o.tint === "color") {
    buf = await sharp(buf).grayscale().tint(hexToRgb(o.tint_color)).png().toBuffer();
  }

  // mask
  if (o.shape !== "none") {
    buf = await sharp(buf)
      .composite([{ input: maskSvg(width, height, o, g.cornerRadiusPx), blend: "dest-in" }])
      .png()
      .toBuffer();
  }

  // shadow — from the MASKED alpha (buf at this point: resized, tinted,
  // masked; not yet bordered or opacity-scaled), so the silhouette matches
  // the shape rather than casting a rectangle behind a circular photo.
  //
  // The first recipe tried here (extractChannel -> blur -> composite back
  // with blend: "dest-in") does not work: extractChannel's output has
  // hasAlpha: false, so it carries no alpha of its own for dest-in to
  // multiply against — verified empirically (B3 Task 3 report). joinChannel
  // attaches the extracted, blurred greyscale directly AS the alpha channel
  // of a black canvas instead, which was verified to behave correctly.
  //
  // Darkness is scaled on the extracted channel via .linear() rather than
  // via the canvas's own alpha, because the canvas is a plain 3-channel
  // black with no alpha of its own to scale. Also verified empirically:
  // .linear() chained directly onto the extractChannel/blur pipeline is a
  // no-op in this sharp version, so the raw buffer is re-wrapped as its own
  // sharp() input before .linear() is applied — only then does it take
  // effect.
  let shadow: Buffer | null = null;
  if (o.shadow) {
    const { data: alphaData, info: alphaInfo } = await sharp(buf)
      .extractChannel("alpha")
      .blur(g.shadowBlurPx)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data: scaledAlpha } = await sharp(alphaData, {
      raw: { width: alphaInfo.width, height: alphaInfo.height, channels: 1 },
    })
      .linear(0.45, 0)
      .raw()
      .toBuffer({ resolveWithObject: true });

    shadow = await sharp({
      create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .joinChannel(scaledAlpha, {
        raw: { width: alphaInfo.width, height: alphaInfo.height, channels: 1 },
      })
      .png()
      .toBuffer();
  }

  // border — after the mask, so it traces the shape rather than the rectangle
  if (g.borderPx > 0) {
    buf = await sharp(buf)
      .composite([{ input: borderSvg(width, height, o, g.cornerRadiusPx, g.borderPx) }])
      .png()
      .toBuffer();
  }

  // opacity — last, scaling the whole composed layer including its border
  if (o.opacity < 100) {
    buf = await sharp(buf)
      .composite([{
        input: {
          create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: o.opacity / 100 } },
        },
        blend: "dest-in",
      }])
      .png()
      .toBuffer();
  }

  return { layer: buf, shadow };
}
