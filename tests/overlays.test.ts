import { describe, expect, it } from "vitest";
import { validateOverlayFields, type OverlayFields } from "@/lib/overlays";

function fields(over: Partial<OverlayFields> = {}): OverlayFields {
  return {
    name: "QR code", image_url: "https://example.test/qr.png", is_slot: false,
    roles: ["payoff"], corner: "bottom-right",
    margin_pct: 5, size_pct: 15, opacity: 100, sort_order: 0, active: true,
    shape: "none", border_width_pct: 0, border_color: "", tint: "none", tint_color: "", shadow: false,
    ...over,
  };
}

describe("validateOverlayFields", () => {
  it("accepts a well-formed overlay", () => {
    expect(() => validateOverlayFields(fields())).not.toThrow();
  });

  it("requires a name", () => {
    expect(() => validateOverlayFields(fields({ name: "  " }))).toThrow(/name/i);
  });

  it("requires an image", () => {
    expect(() => validateOverlayFields(fields({ image_url: "" }))).toThrow(/image/i);
  });

  // An overlay targeting nothing would be silently composited nowhere —
  // the user would see no effect and no error.
  it("rejects an empty role selection", () => {
    expect(() => validateOverlayFields(fields({ roles: [] }))).toThrow(/role/i);
  });

  it("rejects an unknown role", () => {
    expect(() => validateOverlayFields(fields({ roles: ["banner" as never] }))).toThrow(/role/i);
  });

  it("rejects a size outside 1-100", () => {
    expect(() => validateOverlayFields(fields({ size_pct: 0 }))).toThrow(/size/i);
    expect(() => validateOverlayFields(fields({ size_pct: 101 }))).toThrow(/size/i);
  });

  it("rejects a margin outside 0-49", () => {
    expect(() => validateOverlayFields(fields({ margin_pct: -1 }))).toThrow(/margin/i);
    expect(() => validateOverlayFields(fields({ margin_pct: 50 }))).toThrow(/margin/i);
  });

  it("rejects an opacity outside 0-100", () => {
    expect(() => validateOverlayFields(fields({ opacity: 101 }))).toThrow(/opacity/i);
    expect(() => validateOverlayFields(fields({ opacity: -1 }))).toThrow(/opacity/i);
  });

  it("rejects an unknown corner", () => {
    expect(() => validateOverlayFields(fields({ corner: "middle-left" as never }))).toThrow(/corner/i);
  });
});

describe("validateOverlayFields — slots", () => {
  it("accepts a slot with no image, because the idea supplies it", () => {
    expect(() => validateOverlayFields(fields({ is_slot: true, image_url: "" }))).not.toThrow();
  });

  // A slot carrying its own image is contradictory: the per-idea fill would
  // silently win at composite time, so the configured image would never appear
  // and nothing would say why.
  it("rejects a slot that also carries an image", () => {
    expect(() => validateOverlayFields(fields({ is_slot: true, image_url: "https://x.test/a.png" })))
      .toThrow(/slot/i);
  });

  it("still requires an image on a non-slot overlay", () => {
    expect(() => validateOverlayFields(fields({ is_slot: false, image_url: "" })))
      .toThrow(/image/i);
  });
});

describe("validateOverlayFields — treatments", () => {
  it("accepts the default, untreated overlay", () => {
    expect(() => validateOverlayFields(fields())).not.toThrow();
  });

  it("accepts a circular overlay with a border", () => {
    expect(() => validateOverlayFields(
      fields({ shape: "circle", border_width_pct: 4, border_color: "#ff8800" }),
    )).not.toThrow();
  });

  it("rejects an unknown shape", () => {
    expect(() => validateOverlayFields(fields({ shape: "hexagon" as never }))).toThrow(/shape/i);
  });

  it("rejects an unknown tint", () => {
    expect(() => validateOverlayFields(fields({ tint: "sepia" as never }))).toThrow(/tint/i);
  });

  // A border with no colour would render as transparent — visible as nothing,
  // with no error to explain why the setting did nothing.
  it("rejects a border width with no colour", () => {
    expect(() => validateOverlayFields(fields({ border_width_pct: 4 }))).toThrow(/colour|color/i);
  });

  it("rejects a border wider than a quarter of the layer", () => {
    expect(() => validateOverlayFields(
      fields({ border_width_pct: 26, border_color: "#ffffff" }),
    )).toThrow(/border/i);
  });

  it("rejects tint: color with no colour", () => {
    expect(() => validateOverlayFields(fields({ tint: "color" }))).toThrow(/colour|color/i);
  });

  // Silently ignoring it would leave a colour on screen that does nothing.
  it("rejects a tint colour when the tint is not 'color'", () => {
    expect(() => validateOverlayFields(
      fields({ tint: "grayscale", tint_color: "#ff8800" }),
    )).toThrow(/tint/i);
  });

  it("rejects a malformed hex colour", () => {
    expect(() => validateOverlayFields(
      fields({ border_width_pct: 4, border_color: "orange" }),
    )).toThrow(/hex/i);
  });
});
