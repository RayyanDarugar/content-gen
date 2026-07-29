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
