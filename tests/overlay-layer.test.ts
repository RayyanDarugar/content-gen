import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { buildOverlayLayer } from "@/lib/athena/overlay-layer";
import type { CategoryOverlay } from "@/lib/types";

// These render for real. The pure geometry and the stage list are covered in
// overlay-treatments.test.ts; what CANNOT be asserted there is that the
// builder actually follows the list — buildOverlayLayer is driven by
// treatmentStages(), so reordering that list changes what these render.

function ov(over: Partial<CategoryOverlay>): CategoryOverlay {
  return {
    id: "o1", user_id: "u1", category_id: "c1", name: "Test",
    image_url: "", is_slot: false, roles: ["single"], corner: "bottom-right",
    margin_pct: 5, size_pct: 30, opacity: 100, sort_order: 0, active: true,
    shape: "none", border_width_pct: 0, border_color: "", tint: "none",
    tint_color: "", shadow: false,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

// A flat orange source, so any pixel that is not (200,120,40) was treated.
const source = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .png()
    .toBuffer();

async function pixels(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    info,
    at(x: number, y: number) {
      const i = (y * info.width + x) * info.channels;
      return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
    },
    // Bounding box of everything meaningfully opaque.
    bbox() {
      let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          if (data[(y * info.width + x) * info.channels + info.channels - 1] > 8) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
      }
      return { width: maxX - minX + 1, height: maxY - minY + 1, minX, minY };
    },
  };
}

describe("buildOverlayLayer — shape", () => {
  // rx=w/2, ry=h/2 inscribes an ELLIPSE in the layer box, so every portrait
  // overlay (a 324x405 headshot is the real case) got an oval.
  it("masks a true circle on a non-square layer, not an ellipse", async () => {
    const { layer } = await buildOverlayLayer(await source(800, 1000), { width: 324, height: 405 }, ov({ shape: "circle" }));
    const p = await pixels(layer);
    const box = p.bbox();
    // A circle of diameter min(324,405) = 324, centred: as wide as it is tall.
    expect(box.width).toBe(324);
    expect(Math.abs(box.height - box.width)).toBeLessThanOrEqual(1);
    // 180px above the centre is inside the old ellipse (ry 202.5) and outside
    // the circle (r 162) — the pixel that used to prove the bug.
    expect(p.at(162, 405 / 2 - 180 + 1).a).toBe(0);
    expect(p.at(162, Math.round(405 / 2)).a).toBe(255);
  });

  it("keeps the circular border concentric with the circular mask", async () => {
    const { layer } = await buildOverlayLayer(
      await source(800, 1000),
      { width: 324, height: 405 },
      ov({ shape: "circle", border_width_pct: 4, border_color: "#ffffff" }),
    );
    const p = await pixels(layer);
    // Top of the circle (y ~ 202 - 162) and left of it (x ~ 0) both carry the
    // ring; an ellipse's ring would have reached the layer's top edge instead.
    expect(p.at(162, 46)).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    expect(p.at(4, 202)).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    expect(p.at(162, 20).a).toBe(0);
  });
});

describe("buildOverlayLayer — stage order", () => {
  // The shadow is derived from the MASKED alpha, at a point after the mask and
  // before the border. Taken any earlier it is a rectangle behind a circular
  // photo — which is what a border stage moved ahead of the mask produces.
  it("derives the shadow after the mask, so a circle casts a circular shadow", async () => {
    const { shadow } = await buildOverlayLayer(
      await source(400, 400),
      { width: 200, height: 200 },
      ov({ shape: "circle", shadow: true, border_width_pct: 5, border_color: "#ffffff" }),
    );
    expect(shadow).not.toBeNull();
    const p = await pixels(shadow!);
    expect(p.at(100, 100).a).toBeGreaterThan(80);
    expect(p.at(0, 0).a).toBe(0);
  });

  // Opacity is applied last, so it scales the border too — a 50%-opaque
  // overlay with an opaque ring around it would look like a sticker.
  it("applies opacity after the border, fading the border with the layer", async () => {
    const { layer } = await buildOverlayLayer(
      await source(400, 400),
      { width: 200, height: 200 },
      ov({ border_width_pct: 10, border_color: "#ffffff", opacity: 50 }),
    );
    const p = await pixels(layer);
    const edge = p.at(2, 100);
    expect(edge.r).toBe(255);
    expect(edge.a).toBeGreaterThan(100);
    expect(edge.a).toBeLessThan(160);
  });

  // Bordering before masking traces the original rectangle, and the mask then
  // cuts the border's corners off.
  it("borders after masking, so the ring survives the rounded corners", async () => {
    const { layer } = await buildOverlayLayer(
      await source(400, 400),
      { width: 200, height: 200 },
      ov({ shape: "rounded", border_width_pct: 8, border_color: "#ffffff" }),
    );
    const p = await pixels(layer);
    // The rounded corner is cut away...
    expect(p.at(0, 0).a).toBe(0);
    // ...and the ring follows the curve into it rather than stopping short.
    expect(p.at(8, 8)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("resizes first, so every later stage works at the placed size", async () => {
    const { layer, shadow } = await buildOverlayLayer(
      await source(800, 1000),
      { width: 324, height: 405 },
      ov({ shape: "circle", tint: "grayscale", border_width_pct: 3, border_color: "#ffffff", opacity: 80, shadow: true }),
    );
    const m = await sharp(layer).metadata();
    expect([m.width, m.height]).toEqual([324, 405]);
    // The shadow buffer staying EXACTLY the layer's size is what makes the
    // caller's clamp incapable of handing sharp an out-of-bounds composite.
    const s = await sharp(shadow!).metadata();
    expect([s.width, s.height]).toEqual([324, 405]);
  });
});

describe("buildOverlayLayer — malformed stored colours", () => {
  // No CHECK constraint ties tint to tint_color, so a hand-edited or legacy
  // row can carry "". hexToRgb's NaN made sharp throw, and the caller's
  // per-layer catch then dropped the WHOLE overlay rather than just the tint.
  it("skips an unparseable tint instead of losing the overlay", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const bad of ["", "   ", "not-a-colour", "#fff"]) {
        const { layer } = await buildOverlayLayer(
          await source(400, 400),
          { width: 200, height: 200 },
          ov({ tint: "color", tint_color: bad }),
        );
        const p = await pixels(layer);
        expect([p.info.width, p.info.height]).toEqual([200, 200]);
        expect(p.at(100, 100)).toMatchObject({ r: 200, g: 120, b: 40, a: 255 });
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("skips an unparseable border instead of losing the overlay", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { layer } = await buildOverlayLayer(
        await source(400, 400),
        { width: 200, height: 200 },
        ov({ border_width_pct: 10, border_color: "zzzzzz" }),
      );
      const p = await pixels(layer);
      expect([p.info.width, p.info.height]).toEqual([200, 200]);
      expect(p.at(2, 100)).toMatchObject({ r: 200, g: 120, b: 40, a: 255 });
    } finally {
      warn.mockRestore();
    }
  });

  it("still applies a valid colour tint", async () => {
    const { layer } = await buildOverlayLayer(
      await source(400, 400),
      { width: 200, height: 200 },
      ov({ tint: "color", tint_color: "#3366ff" }),
    );
    const p = await pixels(layer);
    expect(p.at(100, 100).b).toBeGreaterThan(200);
    expect(p.at(100, 100).r).toBeLessThan(150);
  });
});

describe("buildOverlayLayer — wide layers", () => {
  // A 1200x60 wordmark at size_pct 40 on a 1080x1350 slide. With the blur
  // keyed off WIDTH, the inset ate the layer's whole height and the shadow
  // came out as a uniform hard-edged bar.
  it("casts a soft shadow on a 432x22 wordmark rather than a solid bar", async () => {
    const { shadow } = await buildOverlayLayer(
      await source(1200, 60),
      { width: 432, height: 22 },
      ov({ shadow: true }),
    );
    const p = await pixels(shadow!);
    expect([p.info.width, p.info.height]).toEqual([432, 22]);
    expect(p.at(216, 11).a).toBeGreaterThan(80);
    // The defect being guarded: a corner as dark as the centre IS the bar.
    expect(p.at(0, 0).a).toBeLessThan(p.at(216, 11).a / 4);
  });
});
