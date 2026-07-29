// Colors and type declared by a site's markup and CSS. Deliberately
// INCLUSIVE and ranked rather than filtered: regex cannot tell a brand
// color from a drop shadow, so the extraction LLM does the judging. This
// only has to find plausible candidates and order them sensibly.

export interface ColorCandidate {
  value: string;
  weight: number;
  source: "theme-color" | "custom-property" | "declaration" | "frequency";
  name?: string;
}
export interface FontCandidate {
  family: string;
  weight: number;
  source: "google-fonts" | "font-face" | "declaration";
}
export interface DesignCandidates { colors: ColorCandidate[]; fonts: FontCandidate[] }

const MAX_COLORS = 24;
const MAX_FONTS = 12;

// CSS generics and system-stack members nobody picks as a brand face.
// Named faces (Helvetica Neue, Roboto) are NOT here — a brand may choose
// them deliberately, and an incidental one ranks low anyway.
const GENERIC_FAMILIES = new Set([
  "sans-serif", "serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
  "-apple-system", "blinkmacsystemfont", "inherit", "initial", "unset",
]);

// Property names that signal a deliberate brand token rather than a scale step.
const BRANDY = /(brand|primary|secondary|accent|highlight|theme)/i;

export function normalizeHex(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  // 3, 4, 6 and 8 digits. The 4- and 8-digit forms (#RGBA / #RRGGBBAA) carry
  // an alpha channel; alpha is dropped rather than the value rejected, the
  // same way rgba() is handled just below — #0f172aff is still #0f172a, and
  // rejecting it silently threw away real brand tokens.
  const hex = s.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    const v = hex[1];
    // Expand-then-strip for the short forms: #abcd → #aabbcc (the d is alpha).
    return v.length <= 4
      ? `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}`
      : `#${v.slice(0, 6)}`;
  }
  const rgb = s.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map(Number);
    if (parts.some((n) => n > 255)) return null;
    return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

export function normalizeFontFamily(raw: string): string | null {
  const first = raw.split(",")[0] ?? "";
  const cleaned = first.replace(/["']/g, "").replace(/\+/g, " ").trim();
  if (!cleaned) return null;
  if (GENERIC_FAMILIES.has(cleaned.toLowerCase())) return null;
  return cleaned;
}

export function parseDesignCandidates(html: string, stylesheets: string[] = []): DesignCandidates {
  const css = [
    ...Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)).map((m) => m[1]),
    ...stylesheets,
  ].join("\n");

  const colors = new Map<string, ColorCandidate>();
  const consider = (value: string | null, weight: number, source: ColorCandidate["source"], name?: string) => {
    if (!value) return;
    const existing = colors.get(value);
    if (!existing || weight > existing.weight) colors.set(value, { value, weight, source, name });
  };

  // 1. theme-color — an explicit declaration, either attribute order.
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/name\s*=\s*["']theme-color["']/i.test(tag)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    consider(normalizeHex(content ?? ""), 100, "theme-color");
  }

  // 2. Custom properties — the name carries intent.
  for (const m of css.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)) {
    consider(normalizeHex(m[2]), BRANDY.test(m[1]) ? 80 : 60, "custom-property", m[1]);
  }

  // 3. Ordinary declarations.
  for (const m of css.matchAll(/(?:^|[\s;{])(?:background|background-color|color|border-color|fill|stroke)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)) {
    consider(normalizeHex(m[1]), 40, "declaration");
  }

  // 4. Frequency across everything, for compiled bundles where names are gone.
  // `css` already carries every <style> block's contents (plus any external
  // stylesheets), so the raw-html scan below must exclude those same
  // <style> blocks — otherwise an inline <style> color is counted once via
  // `css` and again via `html`, doubling its weight relative to an
  // equally-frequent color that only appears in an inline style="" attribute
  // or plain text. Non-greedy, matching the same style-block extraction
  // above — <style> blocks don't nest, so this can't eat past its own tag.
  const htmlOutsideStyleBlocks = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const counts = new Map<string, number>();
  for (const m of [
    ...css.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g),
    ...htmlOutsideStyleBlocks.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g),
  ]) {
    const v = normalizeHex(m[0]);
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  for (const [value, count] of counts) consider(value, Math.min(count, 30), "frequency");

  const fonts = new Map<string, FontCandidate>();
  const considerFont = (raw: string, weight: number, source: FontCandidate["source"]) => {
    const family = normalizeFontFamily(raw);
    if (!family) return;
    const existing = fonts.get(family.toLowerCase());
    if (!existing || weight > existing.weight) fonts.set(family.toLowerCase(), { family, weight, source });
  };

  // Google Fonts URLs carry exact family names — the strongest signal. Scanned
  // in the CSS as well as the markup: the same reference just as often arrives
  // as `@import url(https://fonts.googleapis.com/css2?family=Inter)` inside an
  // inline <style> or a fetched stylesheet as it does in a <link href>, and
  // fetching those stylesheets is the whole point of reading them. `)` is
  // excluded from the URL run so the `url(...)` form's closing paren isn't
  // swallowed into the family name; `;` cannot be excluded, since real hrefs
  // contain it (`family=Inter:wght@400;700`).
  for (const text of [html, css]) {
    for (const m of text.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>)]+)/gi)) {
      for (const fam of m[1].matchAll(/family=([^&:]+)/g)) considerFont(fam[1], 100, "google-fonts");
    }
  }
  for (const m of css.matchAll(/@font-face\s*{[^}]*?font-family\s*:\s*([^;}]+)/gi)) {
    considerFont(m[1], 80, "font-face");
  }
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    considerFont(m[1], 40, "declaration");
  }

  const byWeight = <T extends { weight: number }>(a: T, b: T) => b.weight - a.weight;

  // Occurrence count is a SECOND sort key, not part of `weight`. `consider()`
  // keeps the max weight, and the `declaration` tier is 40 while frequency
  // tops out at min(count, 30) — so any hex named once in a color:/background:
  // /border-color:/fill: declaration is pinned at 40 no matter how often it
  // appears, and in a compiled bundle that is every hex. Weight alone therefore
  // leaves every candidate tied and falling back to document order, which is
  // exactly the Tailwind-bundle case the frequency signal exists for: 30
  // incidental one-off hexes ahead of the 40×-declared brand color pushed the
  // brand color past MAX_COLORS entirely. Ordering ties by real occurrence
  // count restores that. Kept internal — the tiers are the public contract,
  // and count is not on ColorCandidate.
  const occurrences = (c: ColorCandidate) => counts.get(c.value) ?? 0;
  return {
    colors: [...colors.values()]
      .sort((a, b) => byWeight(a, b) || occurrences(b) - occurrences(a))
      .slice(0, MAX_COLORS),
    fonts: [...fonts.values()].sort(byWeight).slice(0, MAX_FONTS),
  };
}
