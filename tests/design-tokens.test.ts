import { describe, expect, it } from "vitest";
import {
  normalizeHex, normalizeFontFamily, parseDesignCandidates,
} from "@/lib/design-tokens";

describe("normalizeHex", () => {
  it("expands shorthand and lowercases", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#0F172A")).toBe("#0f172a");
  });
  it("converts rgb() and drops alpha from rgba()", () => {
    expect(normalizeHex("rgb(15, 23, 42)")).toBe("#0f172a");
    expect(normalizeHex("rgba(15, 23, 42, 0.5)")).toBe("#0f172a");
  });
  it("rejects nonsense", () => {
    expect(normalizeHex("not-a-color")).toBeNull();
    expect(normalizeHex("#12")).toBeNull();
    expect(normalizeHex("rgb(300, 0, 0)")).toBeNull();
  });
});

describe("normalizeFontFamily", () => {
  it("takes the first family and strips quotes", () => {
    expect(normalizeFontFamily(`"Inter", sans-serif`)).toBe("Inter");
    expect(normalizeFontFamily(`'Söhne', Helvetica`)).toBe("Söhne");
  });
  it("decodes + as space (google fonts style)", () => {
    expect(normalizeFontFamily("Open+Sans")).toBe("Open Sans");
  });
  it("drops CSS generics and system-stack members", () => {
    expect(normalizeFontFamily("sans-serif")).toBeNull();
    expect(normalizeFontFamily("system-ui")).toBeNull();
    expect(normalizeFontFamily("-apple-system")).toBeNull();
    expect(normalizeFontFamily("  ")).toBeNull();
  });
  it("keeps a named font that could be a deliberate choice", () => {
    expect(normalizeFontFamily("Helvetica Neue")).toBe("Helvetica Neue");
  });
});

describe("parseDesignCandidates", () => {
  it("ranks a theme-color above frequency-derived colors", () => {
    const html = `
      <head><meta name="theme-color" content="#0f172a"></head>
      <body style="color:#ff0000">x</body>
      <style>.a{color:#ff0000}.b{color:#ff0000}.c{color:#ff0000}</style>`;
    const { colors } = parseDesignCandidates(html);
    expect(colors[0].value).toBe("#0f172a");
    expect(colors[0].source).toBe("theme-color");
    expect(colors.map((c) => c.value)).toContain("#ff0000");
  });

  it("reads google fonts families from the link href", () => {
    const html = `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Open+Sans&display=swap" rel="stylesheet">`;
    const { fonts } = parseDesignCandidates(html);
    expect(fonts.map((f) => f.family)).toEqual(expect.arrayContaining(["Inter", "Open Sans"]));
    expect(fonts[0].source).toBe("google-fonts");
  });

  it("ranks a brand-named custom property above a neutral-named one", () => {
    const css = `:root{--brand-primary:#123456;--gray-300:#eeeeee}`;
    const { colors } = parseDesignCandidates("<html></html>", [css]);
    const brand = colors.find((c) => c.value === "#123456")!;
    const gray = colors.find((c) => c.value === "#eeeeee")!;
    expect(brand.weight).toBeGreaterThan(gray.weight);
    expect(brand.name).toBe("brand-primary");
  });

  it("falls back to frequency ranking for a compiled bundle", () => {
    const css = `.t{color:#aa0000}.u{background:#aa0000}.v{border-color:#aa0000}.w{color:#00bb00}`;
    const { colors } = parseDesignCandidates("<html></html>", [css]);
    expect(colors[0].value).toBe("#aa0000");
  });

  it("reads @font-face families", () => {
    const css = `@font-face{font-family:"Söhne";src:url(/a.woff2)}`;
    const { fonts } = parseDesignCandidates("<html></html>", [css]);
    expect(fonts.map((f) => f.family)).toContain("Söhne");
  });

  it("returns empty arrays for a page with no design signal", () => {
    const out = parseDesignCandidates("<html><body><p>Just words.</p></body></html>");
    expect(out.colors).toEqual([]);
    expect(out.fonts).toEqual([]);
  });

  it("does not throw on malformed or truncated CSS", () => {
    expect(() => parseDesignCandidates("<style>.a{color:#ff", ["@font-face{font-family:"])).not.toThrow();
  });

  it("dedupes, keeping the highest-weight source", () => {
    const html = `<head><meta name="theme-color" content="#0f172a"></head><style>.a{color:#0f172a}</style>`;
    const { colors } = parseDesignCandidates(html);
    expect(colors.filter((c) => c.value === "#0f172a")).toHaveLength(1);
    expect(colors[0].source).toBe("theme-color");
  });

  it("caps the lists", () => {
    const many = Array.from({ length: 60 }, (_, i) => `.c${i}{color:#${i.toString(16).padStart(6, "0")}}`).join("");
    const { colors } = parseDesignCandidates("<html></html>", [many]);
    expect(colors.length).toBeLessThanOrEqual(24);
  });
});
