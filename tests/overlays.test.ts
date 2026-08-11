import { describe, expect, it } from "vitest";
import { validateOverlayFields, type OverlayFields } from "@/lib/overlays";

function fields(over: Partial<OverlayFields> = {}): OverlayFields {
  return {
    name: "QR code", image_url: "https://example.test/qr.png",
    roles: ["payoff"], corner: "bottom-right",
    margin_pct: 5, size_pct: 15, opacity: 100, sort_order: 0, active: true,
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
  });

  it("rejects an unknown corner", () => {
    expect(() => validateOverlayFields(fields({ corner: "middle-left" as never }))).toThrow(/corner/i);
  });
});
