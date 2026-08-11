import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mergeList, parseBrandList } from "@/lib/brand";
import { BrandSection } from "@/app/(app)/config/brand-section";
import type { BrandProfile } from "@/lib/types";

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
//
// This has to actually mount BrandSection, not just re-exercise
// parseBrandList/mergeList (lib/brand.ts is already covered above) — a test
// that only calls those two functions can't fail if brand-section.tsx stops
// emitting the fields at all, which is exactly the defect. This repo's
// vitest config is plain node with no jsdom/RTL, but react-dom/server is
// already a dependency and renderToStaticMarkup works as an ordinary
// node-environment test — no config change, no stubbing of ./actions.
describe("BrandSection markup (guards the design-token zero-out defect)", () => {
  const brand: BrandProfile = {
    id: "b1",
    user_id: "u1",
    is_default: true,
    business_name: "Acme",
    business_description: "",
    audience: "",
    voice: "",
    avoid: "",
    proof_points: [],
    standing: [],
    colors: ["#111111", "#ffffff"],
    fonts: ["Inter", "Georgia"],
    visual_notes: "Clean, editorial, lots of white space.",
    created_at: "",
    updated_at: "",
  };

  it("always emits colors/fonts/visual_notes fields carrying the current values", () => {
    const html = renderToStaticMarkup(createElement(BrandSection, { brand }));

    expect(html).toContain('name="colors"');
    expect(html).toContain('name="fonts"');
    expect(html).toContain('name="visual_notes"');

    // The hidden inputs must actually carry the serialized current lists,
    // not just be present with some other value — HTML-attribute-encode the
    // JSON the same way React does (" -> &quot;) since this is markup, not
    // a live DOM.
    const encode = (s: string) => s.replace(/"/g, "&quot;");
    expect(html).toContain(encode(JSON.stringify(brand.colors)));
    expect(html).toContain(encode(JSON.stringify(brand.fonts)));
  });

  it("still emits the (empty) fields when there is no brand yet", () => {
    // Confirms parseBrandList(formData.get("colors")) sees "[]", not a
    // missing key, even before any brand row exists — a save on a
    // never-before-saved brand must not throw or silently omit the field.
    const html = renderToStaticMarkup(createElement(BrandSection, { brand: null }));

    expect(html).toContain('name="colors"');
    expect(html).toContain('name="fonts"');
    expect(html).toContain('name="visual_notes"');
    expect(html).toContain('value="[]"');
  });
});
