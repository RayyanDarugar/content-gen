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
  it("drops the alpha channel from 8- and 4-digit hex", () => {
    // The candidate regexes match #[0-9a-fA-F]{3,8} deliberately, so
    // #RRGGBBAA / #RGBA reach here; returning null for them silently dropped
    // real tokens (`:root{--brand-primary:#0f172aff}` yielded no colors).
    expect(normalizeHex("#0F172AFF")).toBe("#0f172a");
    expect(normalizeHex("#0f172a80")).toBe("#0f172a");
    expect(normalizeHex("#ABCD")).toBe("#aabbcc");
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
    // The ONE-OFF color is declared first, so document order works against the
    // expectation. Both colors land in the `declaration` tier at weight 40 (a
    // hex named even once in a color:/background:/border-color: declaration is
    // pinned there, and frequency tops out below it at min(count, 30)), so
    // nothing but a real frequency signal can put #aa0000 on top. The previous
    // fixture declared #aa0000 first and passed on Map insertion order alone.
    const css = `.w{color:#00bb00}.t{color:#aa0000}.u{background:#aa0000}.v{border-color:#aa0000}`;
    const { colors } = parseDesignCandidates("<html></html>", [css]);
    expect(colors[0].value).toBe("#aa0000");
    expect(colors[0].weight).toBe(40);
    expect(colors.find((c) => c.value === "#00bb00")!.weight).toBe(40);
  });

  it("keeps a heavily-declared brand color when one-off colors would fill the cap", () => {
    // The Tailwind-compiled case frequency ranking exists for. 30 incidental
    // hexes declared once each, then the brand color declared 40 times: all 31
    // sit at weight 40, so with weight as the only ordering key the brand color
    // lands 31st and MAX_COLORS = 24 cuts it out of the result entirely.
    const incidental = Array.from(
      { length: 30 },
      (_, i) => `.i${i}{color:#${(0x110000 + i).toString(16)}}`,
    ).join("");
    const brand = ".b{color:#0f172a}".repeat(40);
    const { colors } = parseDesignCandidates("<html></html>", [incidental + brand]);
    expect(colors[0].value).toBe("#0f172a");
    expect(colors[0].weight).toBe(40);
  });

  it("reads a google fonts @import from a fetched stylesheet, not just the markup", () => {
    // Fetching linked stylesheets is the point of the fetch side; a site that
    // pulls its face in via @import rather than a <link> must not come back
    // with fonts: [].
    const css = `@import url(https://fonts.googleapis.com/css2?family=Inter:wght@400;700);`;
    const { fonts } = parseDesignCandidates("<html></html>", [css]);
    expect(fonts[0]).toMatchObject({ family: "Inter", weight: 100, source: "google-fonts" });
  });

  it("does not let a <style> block swallow the markup between it and the next one", () => {
    // Guards the non-greedy `([\s\S]*?)` in the <style> extraction. Made
    // greedy, the "CSS" would run from the first <style> to the LAST </style>,
    // pulling the markup in between into `css` — where #abcdef is then counted
    // once via `css` and again via the raw-html scan, doubling its weight to 2.
    // The existing double-count test cannot catch this: both its hexes live
    // inside <style> blocks, so it mutates symmetrically.
    const html = `
      <style>.a{color:#111111}</style>
      <div data-swatch="#abcdef">between</div>
      <style>.b{color:#222222}</style>`;
    const { colors } = parseDesignCandidates(html);
    const between = colors.find((c) => c.value === "#abcdef")!;
    expect(between.source).toBe("frequency");
    expect(between.weight).toBe(1);
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

  it("does not double-count a <style>-block color relative to an equally-frequent inline one", () => {
    // #aa0000 appears twice, both inside <style> blocks. #00bb00 appears
    // twice, both via inline style="" attributes outside any <style> block.
    // True frequency is identical (2 each); neither uses a recognized
    // declaration property (outline-color isn't in the declaration
    // allowlist), so both land purely through the frequency pass. Before the
    // fix, the <style>-block color was scanned once via the extracted `css`
    // string and again via the raw `html` string, doubling its weight to 4
    // against the inline color's correct 2.
    const html = `
      <style>.a{outline-color:#aa0000}</style>
      <style>.b{outline-color:#aa0000}</style>
      <div style="outline-color:#00bb00">x</div>
      <span style="outline-color:#00bb00">y</span>`;
    const { colors } = parseDesignCandidates(html);
    const styleBlockColor = colors.find((c) => c.value === "#aa0000")!;
    const inlineColor = colors.find((c) => c.value === "#00bb00")!;
    expect(styleBlockColor.source).toBe("frequency");
    expect(inlineColor.source).toBe("frequency");
    expect(styleBlockColor.weight).toBe(inlineColor.weight);
  });
});
