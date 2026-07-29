import { describe, expect, it } from "vitest";
import { parseBrandList } from "@/lib/brand";

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
