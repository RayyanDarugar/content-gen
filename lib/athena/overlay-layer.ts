import "server-only";
import sharp from "sharp";
import { treatmentGeometry, treatmentStages } from "@/lib/athena/overlay-treatments";
import type { CategoryOverlay } from "@/lib/types";

// Returns null rather than NaN components on anything unparseable. Both
// mutations validate these columns, but no CHECK constraint ties tint to
// tint_color in the database, so a hand-edited or legacy row can still carry
// "" — and NaN reaches sharp as "Expected number for background.red", which
// the caller's per-layer catch turns into the WHOLE overlay vanishing rather
// than just its tint. Parsing defensively lets the stage be skipped instead.
//
// The same check also keeps an unvalidated stored string out of the border
// SVG's stroke attribute.
function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// A circle is inscribed on the SHORTER side and centred, not stretched to the
// layer box: rx=w/2, ry=h/2 draws an ELLIPSE on every non-square overlay (a
// 324x405 headshot is the real case), and an oval is not what "circle" means.
// The transparent margin left on the long axis is correct — a circular crop of
// a portrait is a circle with space above and below it.
function circleRadius(w: number, h: number): number {
  return Math.min(w, h) / 2;
}

// The mask shape, as an SVG the size of the layer. White where the layer
// should survive; compositing it with dest-in multiplies the layer's alpha by
// this, so anything outside the shape becomes transparent.
function maskSvg(w: number, h: number, o: CategoryOverlay, radius: number): Buffer {
  const body =
    o.shape === "circle"
      ? `<circle cx="${w / 2}" cy="${h / 2}" r="${circleRadius(w, h)}" fill="#fff"/>`
      : `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/>`;
  return Buffer.from(`<svg width="${w}" height="${h}">${body}</svg>`);
}

// The border traces the MASK's shape, drawn inset by half its width so the
// stroke sits fully inside the layer rather than being clipped in half.
function borderSvg(
  w: number,
  h: number,
  o: CategoryOverlay,
  radius: number,
  px: number,
  color: string,
): Buffer {
  const i = px / 2;
  const body =
    o.shape === "circle"
      ? `<circle cx="${w / 2}" cy="${h / 2}" r="${circleRadius(w, h) - i}" fill="none" stroke="${color}" stroke-width="${px}"/>`
      : `<rect x="${i}" y="${i}" width="${w - px}" height="${h - px}" rx="${Math.max(0, radius - i)}" ry="${Math.max(0, radius - i)}" fill="none" stroke="${color}" stroke-width="${px}"/>`;
  return Buffer.from(`<svg width="${w}" height="${h}">${body}</svg>`);
}

// Derives the shadow from whatever alpha `buf` currently carries. Called from
// exactly one point in the stage loop below — see the comment there.
//
// The first recipe tried here (extractChannel -> blur -> composite back with
// blend: "dest-in") does not work: extractChannel's output has hasAlpha:
// false, so it carries no alpha of its own for dest-in to multiply against —
// verified empirically (B3 Task 3 report). joinChannel attaches the extracted,
// blurred greyscale directly AS the alpha channel of a black canvas instead,
// which was verified to behave correctly.
//
// Darkness is scaled on the extracted channel via .linear() rather than via
// the canvas's own alpha, because the canvas is a plain 3-channel black with
// no alpha of its own to scale. Also verified empirically: .linear() chained
// directly onto the extractChannel/blur pipeline is a no-op in this sharp
// version, so the raw buffer is re-wrapped as its own sharp() input before
// .linear() is applied — only then does it take effect.
async function buildShadow(
  buf: Buffer,
  width: number,
  height: number,
  blurPx: number,
  opacity: number,
): Promise<Buffer> {
  const b = blurPx;
  // For any shape but circle, the masked alpha is uniform 255 all the way to
  // the buffer's edge — blur has no transparent margin to bleed into, so
  // shape: "none" (and rounded's straight edges) produced a hard-edged block
  // instead of a soft shadow (measured pre-fix: alpha 255 at the corner, edge
  // midpoint, AND centre of a 200px layer — see the B3 Task 3 report). Fix:
  // shrink the silhouette by the blur radius on each side, then pad it back
  // out to the full buffer size with a transparent margin, so the blur has
  // room to soften every edge. The shadow buffer itself stays exactly
  // width x height throughout — that's load-bearing for the caller's clamp,
  // which assumes it never needs to handle an out-of-bounds composite.
  //
  // The blur radius keys off the layer's SHORTER side (see overlay-treatments
  // .ts), which is what keeps this inset from eating a wide layer's whole
  // height and reaching the degenerate branch below.
  //
  // Kept as one unbroken pipeline through to .raw(): round-tripping the
  // extracted channel through an intermediate .png().toBuffer() and reloading
  // it was measured to upconvert the single-channel greyscale to 3 channels on
  // the next .blur() (verified empirically — see the B3 Task 3 report), which
  // would have silently corrupted the alpha data read below.
  const insetW = width - 2 * b;
  const insetH = height - 2 * b;
  const alphaPipeline =
    insetW < 1 || insetH < 1
      ? // Degenerate case: the layer is too small for the blur radius to inset
        // without collapsing to nothing. Skip the inset and blur the
        // silhouette as-is rather than erroring.
        sharp(buf).extractChannel("alpha").blur(b)
      : sharp(buf)
          .extractChannel("alpha")
          .resize(insetW, insetH, { fit: "fill" })
          .extend({ top: b, bottom: b, left: b, right: b, background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .blur(b);
  const { data: alphaData, info: alphaInfo } = await alphaPipeline.raw().toBuffer({ resolveWithObject: true });

  // Darkness (0.45) and the overlay's own opacity both scale the same channel:
  // a faded overlay should cast a faded shadow, not a full-strength one.
  const { data: scaledAlpha } = await sharp(alphaData, {
    raw: { width: alphaInfo.width, height: alphaInfo.height, channels: 1 },
  })
    .linear((0.45 * opacity) / 100, 0)
    .raw()
    .toBuffer({ resolveWithObject: true });

  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .joinChannel(scaledAlpha, {
      raw: { width: alphaInfo.width, height: alphaInfo.height, channels: 1 },
    })
    .png()
    .toBuffer();
}

// Applies treatments in the one order that is correct (spec §4):
// resize -> tint -> mask -> border -> opacity, with the shadow taken from the
// MASKED alpha so a circular photo casts a circular shadow.
//
// That order is not restated here: this function IS driven by
// treatmentStages(), so the list is the single source of truth for both which
// stages run and in what sequence, and the ordering tests over that pure
// function guard the rendered result rather than a parallel description of it.
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

  let buf = raw;
  let shadow: Buffer | null = null;
  let shadowDone = false;
  let masked = false;

  for (const stage of treatmentStages(o)) {
    // The shadow is not a stage — it is a second output derived from the
    // layer's alpha, not a transform of the layer — so treatmentStages does
    // not list it and it needs a defined point in this loop. That point is
    // IMMEDIATELY AFTER the mask stage (a circular photo must cast a circular
    // shadow, not a rectangular one) and BEFORE the border stage (which is why
    // reaching "border" without having masked triggers it too, and why a stage
    // list that ends before either is covered after the loop).
    if (o.shadow && !shadowDone && (masked || stage === "border" || stage === "opacity")) {
      shadow = await buildShadow(buf, width, height, g.shadowBlurPx, o.opacity);
      shadowDone = true;
    }

    switch (stage) {
      case "resize":
        buf = await sharp(raw).resize(width, height, { fit: "fill" }).ensureAlpha().png().toBuffer();
        break;

      // Before the mask, or the mask's antialiased edge keeps untinted pixels.
      case "tint": {
        if (o.tint === "grayscale") {
          buf = await sharp(buf).grayscale().png().toBuffer();
          break;
        }
        // sharp is a declarative pipeline with a fixed internal operation
        // order: grayscale is always applied AFTER tint regardless of chain
        // order, so .grayscale().tint(...) collapses to plain grey (measured:
        // 135,135,135 vs tint-alone's 94,125,255 on a 200/120/40 input tinted
        // #3366ff — see the B3 Task 3 report). tint() already works in LAB
        // space, preserving luminance and replacing chroma — that IS the
        // monotone this needs.
        const rgb = parseHexRgb(o.tint_color);
        if (!rgb) {
          // Skip the stage, keep the layer: a stored colour the mutations
          // would have rejected must not cost the user their logo.
          console.error(`overlay "${o.name}" (${o.id}): unparseable tint_color, tint skipped`);
          break;
        }
        buf = await sharp(buf).tint(rgb).png().toBuffer();
        break;
      }

      case "mask":
        buf = await sharp(buf)
          .composite([{ input: maskSvg(width, height, o, g.cornerRadiusPx), blend: "dest-in" }])
          .png()
          .toBuffer();
        masked = true;
        break;

      // After the mask, so it traces the shape rather than the rectangle.
      case "border": {
        if (g.borderPx <= 0) break;
        const color = parseHexRgb(o.border_color);
        if (!color) {
          console.error(`overlay "${o.name}" (${o.id}): unparseable border_color, border skipped`);
          break;
        }
        // Rebuilt from the parsed components rather than interpolating the
        // stored string: the SVG then carries only digits this file produced.
        const stroke = `rgb(${color.r},${color.g},${color.b})`;
        buf = await sharp(buf)
          .composite([{ input: borderSvg(width, height, o, g.cornerRadiusPx, g.borderPx, stroke) }])
          .png()
          .toBuffer();
        break;
      }

      // Last of all, scaling the whole composed layer including its border.
      case "opacity":
        buf = await sharp(buf)
          .composite([{
            input: {
              create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: o.opacity / 100 } },
            },
            blend: "dest-in",
          }])
          .png()
          .toBuffer();
        break;
    }
  }

  // A stage list with no border and no opacity stage ends before the shadow's
  // insertion point above ever comes round.
  if (o.shadow && !shadowDone) {
    shadow = await buildShadow(buf, width, height, g.shadowBlurPx, o.opacity);
  }

  return { layer: buf, shadow };
}
