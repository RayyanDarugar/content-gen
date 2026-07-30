import { describe, expect, it } from "vitest";
import { writebackPlan, inventedFormatRow } from "@/lib/athena/suggestion-writeback";
import type { InventedFormat } from "@/lib/types";

const invented: InventedFormat = {
  name: "Myth bust",
  structure: "Hook states the myth, beats dismantle it, payoff gives the insight.",
  why_it_works: "A curiosity gap the payoff closes.",
  brand_fit: "Brands with a teaching voice.",
};

describe("writebackPlan", () => {
  it("does nothing when there is no suggestion", () => {
    expect(writebackPlan(null)).toEqual({ kind: "none" });
  });

  it("links an existing format when the suggestion drew on the library", () => {
    expect(writebackPlan({ format_id: "f1", invented_format: null }))
      .toEqual({ kind: "link", formatId: "f1" });
  });

  it("creates a format when the model invented the structure", () => {
    expect(writebackPlan({ format_id: null, invented_format: invented }))
      .toEqual({ kind: "create", invented });
  });

  it("does nothing when invented with no usable structure to save", () => {
    expect(writebackPlan({ format_id: null, invented_format: null })).toEqual({ kind: "none" });
    expect(writebackPlan({ format_id: null, invented_format: { ...invented, structure: "  " } }))
      .toEqual({ kind: "none" });
  });

  // A library-drawn suggestion must never also mint a row, or every accepted
  // suggestion would duplicate the format it came from.
  it("prefers linking over creating when both are somehow present", () => {
    expect(writebackPlan({ format_id: "f1", invented_format: invented }))
      .toEqual({ kind: "link", formatId: "f1" });
  });
});

describe("inventedFormatRow", () => {
  it("marks the row invented, private, and owned by the user", () => {
    const row = inventedFormatRow("u1", invented);
    expect(row.user_id).toBe("u1");
    expect(row.origin).toBe("invented");
    expect(row.shared).toBe(false);
    expect(row.active).toBe(true);
  });

  it("carries the model's own words rather than reconstructing them", () => {
    const row = inventedFormatRow("u1", invented);
    expect(row.structure).toBe(invented.structure);
    expect(row.why_it_works).toBe(invented.why_it_works);
    expect(row.brand_fit).toBe(invented.brand_fit);
  });

  it("leaves observed-only fields empty", () => {
    const row = inventedFormatRow("u1", invented);
    expect(row.source_example).toBe("");
    expect(row.screenshot_url).toBe("");
  });

  it("falls back to a placeholder name rather than writing an empty one", () => {
    expect(inventedFormatRow("u1", { ...invented, name: "   " }).name).toBe("Untitled format");
  });
});
