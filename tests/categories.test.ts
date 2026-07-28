import { describe, expect, it } from "vitest";
import { slugify, validateCategoryFields, type CategoryFields } from "@/lib/categories";

const base: CategoryFields = {
  name: "Test", style_guide: "", output_format: "", style_ref_url: "",
  post_caption: "", buffer_channel_id: "", images_per_carousel: 5,
  aspect_ratio: "4:5", active: true, post_type: "independent", role_guides: {},
};

describe("slugify", () => {
  it("uppercases and underscores", () => {
    expect(slugify("My Cool Cat!")).toBe("MY_COOL_CAT");
  });
  it("falls back to CATEGORY on empty input", () => {
    expect(slugify("  ")).toBe("CATEGORY");
  });
});

describe("validateCategoryFields", () => {
  it("accepts a valid independent category", () => {
    expect(() => validateCategoryFields(base)).not.toThrow();
  });
  it("rejects an empty name", () => {
    expect(() => validateCategoryFields({ ...base, name: " " })).toThrow(/name/i);
  });
  it("rejects narrative with fewer than 2 slides", () => {
    expect(() =>
      validateCategoryFields({ ...base, post_type: "narrative", images_per_carousel: 1 }),
    ).toThrow(/at least 2/);
  });
  it("rejects an unknown role in role_guides", () => {
    expect(() =>
      validateCategoryFields({ ...base, role_guides: { closer: "x" } as never }),
    ).toThrow(/unknown role/);
  });
  it("rejects a non-string role guide", () => {
    expect(() =>
      validateCategoryFields({ ...base, role_guides: { hook: 3 } as never }),
    ).toThrow(/must be a string/);
  });
  it("rejects out-of-range images_per_carousel", () => {
    expect(() => validateCategoryFields({ ...base, images_per_carousel: 11 })).toThrow(/1-10/);
  });
});
