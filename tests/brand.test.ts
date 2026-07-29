import { describe, expect, it } from "vitest";
import { mergeList, parseBrandList } from "@/lib/brand";

describe("parseBrandList", () => {
  it("accepts an array of strings, trimming and dropping empties", () => {
    expect(parseBrandList(["  a  ", "", "b", "   "])).toEqual(["a", "b"]);
  });
  it("accepts a JSON string of an array (the form-post path)", () => {
    expect(parseBrandList('["a","b"]')).toEqual(["a", "b"]);
  });
  it("treats an empty or missing value as an empty list", () => {
    expect(parseBrandList("")).toEqual([]);
    expect(parseBrandList(undefined)).toEqual([]);
    expect(parseBrandList(null)).toEqual([]);
  });
  it("caps the list at 50 items", () => {
    expect(parseBrandList(Array.from({ length: 60 }, (_, i) => `p${i}`))).toHaveLength(50);
  });
  it("rejects a non-array shape", () => {
    expect(() => parseBrandList('{"a":1}')).toThrow();
    expect(() => parseBrandList(42 as never)).toThrow();
  });
  it("rejects non-string items", () => {
    expect(() => parseBrandList([1, 2] as never)).toThrow();
  });
});

describe("mergeList", () => {
  it("keeps existing items as-is and in order, appending incoming after them", () => {
    expect(mergeList(["a", "b"], ["c", "d"])).toEqual({ merged: ["a", "b", "c", "d"], added: ["c", "d"] });
  });
  it("dedupes incoming items against existing ones case-insensitively", () => {
    expect(mergeList(["Acme Inc"], ["acme inc", "New thing"])).toEqual({
      merged: ["Acme Inc", "New thing"],
      added: ["New thing"],
    });
  });
  it("dedupes within the incoming batch itself", () => {
    expect(mergeList([], ["Acme", "acme", "Acme "])).toEqual({ merged: ["Acme"], added: ["Acme"] });
  });
  it("trims incoming items and drops blanks", () => {
    expect(mergeList(["a"], ["  b  ", "", "   "])).toEqual({ merged: ["a", "b"], added: ["b"] });
  });
  it("returns the existing list untouched when incoming is empty", () => {
    expect(mergeList(["a", "b"], [])).toEqual({ merged: ["a", "b"], added: [] });
  });
  it("returns an empty merge when both lists are empty", () => {
    expect(mergeList([], [])).toEqual({ merged: [], added: [] });
  });
  it("adds everything when existing is empty", () => {
    expect(mergeList([], ["a", "b"])).toEqual({ merged: ["a", "b"], added: ["a", "b"] });
  });
});

// Regression coverage for the zero-out defect flagged in Task 3's review:
// saveBrandProfile (app/(app)/config/actions.ts) upserts colors, fonts, and
// visual_notes on every save, and PostgREST's ON CONFLICT DO UPDATE sets
// every column present in that payload — so a save whose FormData is
// missing those keys writes them back as empty, silently discarding
// whatever extraction (or a previous manual edit) had put there. The fix is
// in brand-section.tsx: hidden inputs (colors, fonts) seeded from the
// current list state and a named visual_notes textarea now always ride
// along in the FormData, exactly as proof_points/standing already did.
// There's no jsdom/RTL harness in this repo to mount that component, so
// this test exercises the same two functions saveBrandProfile calls
// (parseBrandList and the visual_notes trim) against FormData built the two
// ways the form can produce it: what brand-section.tsx emits post-fix, and
// what it would have emitted pre-fix (the fields simply absent).
describe("brand form round trip (guards the design-token zero-out defect)", () => {
  const brand = {
    colors: ["#111111", "#ffffff"],
    fonts: ["Inter", "Georgia"],
    visual_notes: "Clean, editorial, lots of white space.",
  };

  it("preserves colors/fonts/visual_notes on a save that never touches them", () => {
    // Mirrors brand-section.tsx exactly: hidden inputs carry JSON.stringify
    // of whatever list state was seeded from `brand`, unchanged by the user.
    const formData = new FormData();
    formData.set("colors", JSON.stringify(brand.colors));
    formData.set("fonts", JSON.stringify(brand.fonts));
    formData.set("visual_notes", brand.visual_notes);

    expect(parseBrandList(formData.get("colors"))).toEqual(brand.colors);
    expect(parseBrandList(formData.get("fonts"))).toEqual(brand.fonts);
    expect(String(formData.get("visual_notes") ?? "").trim()).toEqual(brand.visual_notes);
  });

  it("demonstrates the defect this guards against: an omitted field reads back empty", () => {
    // The pre-fix shape: a form with no colors/fonts/visual_notes fields at
    // all. This is exactly what would zero out a brand's real design tokens
    // on the very next save after extraction populated them.
    const formData = new FormData();

    expect(parseBrandList(formData.get("colors"))).toEqual([]);
    expect(parseBrandList(formData.get("fonts"))).toEqual([]);
    expect(String(formData.get("visual_notes") ?? "").trim()).toEqual("");
  });
});
