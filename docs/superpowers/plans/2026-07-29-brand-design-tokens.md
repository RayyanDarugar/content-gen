# Brand Design Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scrape colors, fonts, and a short visual note from the site already being read during brand extraction, store them on the brand, and feed them into style-guide drafting as the default a post type may deliberately override.

**Architecture:** A pure parser turns raw HTML plus linked stylesheets into a ranked candidate list; the existing brand-extraction LLM call judges which candidates are actually the brand's and returns them as three more fields on the same draft. One LLM call, one page fetch. `brandBlock` carries them to every prompt surface, byte-identically when empty.

**Tech Stack:** Next.js App Router (nonstandard — see constraints), Supabase, `@anthropic-ai/sdk` + `zodOutputFormat`, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-brand-design-tokens-design.md`

## Global Constraints

- **`fetchPageText`'s external behaviour must not change.** `lib/fetch-page.ts` has been regressed twice (a greedy `<script>` strip and a greedy comment strip, each of which silently gutted page text). Task 2 refactors it to share a fetch; its existing tests must pass **unedited** — they are the safety net.
- **`brandBlock`'s output must be byte-identical to today when `colors`, `fonts`, and `visual_notes` are all empty** — asserted with an exact `toBe`, because six prompt surfaces read it.
- **The parser is inclusive and ranked; the model judges.** Do not hand-filter colors down to a "correct" palette in code — regex cannot tell a brand color from a shadow, and that is precisely the judgment the LLM call exists for. Rank, cap, and pass along.
- **The prompt must not invent a palette.** A site with no design signal yields empty arrays — a correct answer, exactly as an empty `proof_points` is for a thin source.
- **Stylesheet fetching reuses the existing hardened path** — `assertFetchableUrl`, per-hop redirect validation, `AbortSignal.timeout`, size caps. Never write a second fetch helper. Capped at 3 sheets; a sheet that fails is skipped, never fatal.
- No new tables. Migration 0016 adds three columns to `brand_profiles`, all defaulted so existing rows are untouched.
- **This is NOT the Next.js you know** (AGENTS.md): mirror existing conventions; check `node_modules/next/dist/docs/` when unsure.
- Tests: `npx vitest run` (323 passing at plan time). Battery adds `npx tsc --noEmit`, `npm run build`, and **`npx eslint app lib components tests scripts` — lint those directories, NOT `.`**, which picks up `.claude/` scratch and reports thousands of unrelated problems. Only expected finding: the pre-existing `scripts/import-athena-legacy.ts` unused-var warning.
- Commit to the working branch from the worktree; confirm with `git rev-parse --abbrev-ref HEAD` before committing.

---

### Task 1: The design-token parser

Pure, no IO, the largest test surface in this plan. Built first because it defines the types the fetcher feeds.

**Files:**
- Create: `lib/design-tokens.ts`
- Test: `tests/design-tokens.test.ts`

**Interfaces:**
- Produces (Tasks 2-3 consume):
  ```ts
  export interface ColorCandidate { value: string; weight: number; source: "theme-color" | "custom-property" | "declaration" | "frequency"; name?: string }
  export interface FontCandidate { family: string; weight: number; source: "google-fonts" | "font-face" | "declaration" }
  export interface DesignCandidates { colors: ColorCandidate[]; fonts: FontCandidate[] }
  export function normalizeHex(raw: string): string | null
  export function normalizeFontFamily(raw: string): string | null
  export function parseDesignCandidates(html: string, stylesheets?: string[]): DesignCandidates
  ```
  `parseDesignCandidates` returns candidates sorted by descending weight, deduped by value/family (highest weight wins), capped at 24 colors and 12 fonts.

- [ ] **Step 1: Write the failing tests**

`tests/design-tokens.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/design-tokens.test.ts`
Expected: FAIL — cannot resolve `@/lib/design-tokens`.

- [ ] **Step 3: Implement**

`lib/design-tokens.ts` — no `server-only` import; it is pure and the tests import it directly.

```ts
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
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const v = hex[1];
    return v.length === 3 ? `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}` : `#${v}`;
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
  const counts = new Map<string, number>();
  for (const m of [...css.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g), ...html.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)]) {
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

  // Google Fonts hrefs carry exact family names — the strongest signal.
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi)) {
    for (const fam of m[1].matchAll(/family=([^&:]+)/g)) considerFont(fam[1], 100, "google-fonts");
  }
  for (const m of css.matchAll(/@font-face\s*{[^}]*?font-family\s*:\s*([^;}]+)/gi)) {
    considerFont(m[1], 80, "font-face");
  }
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    considerFont(m[1], 40, "declaration");
  }

  const byWeight = <T extends { weight: number }>(a: T, b: T) => b.weight - a.weight;
  return {
    colors: [...colors.values()].sort(byWeight).slice(0, MAX_COLORS),
    fonts: [...fonts.values()].sort(byWeight).slice(0, MAX_FONTS),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/design-tokens.test.ts` — PASS. Run `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/design-tokens.ts tests/design-tokens.test.ts
git commit -m "feat: parse ranked color and font candidates from markup and CSS"
```

---

### Task 2: Share the fetch, and fetch linked stylesheets

**Files:**
- Modify: `lib/fetch-page.ts`
- Test: `tests/fetch-page.test.ts` (extend — do NOT edit existing cases)

**Interfaces:**
- Produces (Task 3 consumes):
  ```ts
  export async function fetchPageHtml(rawUrl: string): Promise<{ html: string; finalUrl: string }>
  export function stylesheetHrefs(html: string, baseUrl: string): string[]
  export async function fetchStylesheets(html: string, baseUrl: string): Promise<string[]>
  ```
  `fetchPageText` keeps its exact signature and behaviour, reimplemented over `fetchPageHtml`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/fetch-page.test.ts` (the file already has `vi.mock("server-only", () => ({}))` at the top — reuse it):

```ts
import { stylesheetHrefs } from "@/lib/fetch-page";

describe("stylesheetHrefs", () => {
  const base = "https://example.com/about/";
  it("resolves relative and absolute hrefs against the final url", () => {
    const html = `
      <link rel="stylesheet" href="/assets/app.css">
      <link rel="stylesheet" href="theme.css">
      <link rel="stylesheet" href="https://cdn.example.com/x.css">`;
    expect(stylesheetHrefs(html, base)).toEqual([
      "https://example.com/assets/app.css",
      "https://example.com/about/theme.css",
      "https://cdn.example.com/x.css",
    ]);
  });
  it("ignores non-stylesheet links", () => {
    const html = `<link rel="icon" href="/favicon.ico"><link rel="preconnect" href="https://fonts.gstatic.com">`;
    expect(stylesheetHrefs(html, base)).toEqual([]);
  });
  it("handles attribute order and extra rel tokens", () => {
    const html = `<link href="/a.css" rel="stylesheet"><link rel="preload stylesheet" href="/b.css">`;
    expect(stylesheetHrefs(html, base)).toContain("https://example.com/a.css");
    expect(stylesheetHrefs(html, base)).toContain("https://example.com/b.css");
  });
  it("caps at 3 and drops unparseable hrefs", () => {
    const html = ["/1.css", "/2.css", "/3.css", "/4.css"]
      .map((h) => `<link rel="stylesheet" href="${h}">`).join("") +
      `<link rel="stylesheet" href="::::">`;
    expect(stylesheetHrefs(html, base)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fetch-page.test.ts`
Expected: FAIL — `stylesheetHrefs` is not exported. The existing cases still pass.

- [ ] **Step 3: Refactor `fetchPageText` over a new `fetchPageHtml`**

In `lib/fetch-page.ts`, lift the fetch/redirect/size-cap body of `fetchPageText` into:

```ts
// The raw fetch, shared so one page load can serve both readable text and
// design-token parsing. fetchPageText is a thin wrapper over this — its
// behaviour is unchanged, and its tests are the proof.
export async function fetchPageHtml(rawUrl: string): Promise<{ html: string; finalUrl: string }>
```
returning the decoded HTML and the URL actually reached after redirects (needed to resolve relative stylesheet hrefs). Then:

```ts
export async function fetchPageText(rawUrl: string): Promise<string> {
  const { html } = await fetchPageHtml(rawUrl);
  return extractReadableText(html);
}
```

**Every existing guard moves with the body, unchanged**: `assertFetchableUrl` on the initial URL and on each redirect hop, `redirect: "manual"`, per-hop `AbortSignal.timeout(FETCH_TIMEOUT_MS)`, the `text/*` content-type requirement, and the streaming `MAX_BYTES` abort. Do not "tidy" any of it — two of those exist because of specific regressions.

- [ ] **Step 4: Add stylesheet discovery and fetching**

```ts
const MAX_STYLESHEETS = 3;

export function stylesheetHrefs(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = tag.match(/rel\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    if (!/\bstylesheet\b/i.test(rel)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      out.push(new URL(href, baseUrl).toString());
    } catch {
      // An unparseable href is skipped, not fatal.
    }
    if (out.length === MAX_STYLESHEETS) break;
  }
  return out;
}

// Best-effort: a sheet that fails to load degrades the design-token
// result, it never fails the extraction run. Each goes through the same
// assertFetchableUrl/redirect/timeout path as the page itself.
export async function fetchStylesheets(html: string, baseUrl: string): Promise<string[]> {
  const sheets: string[] = [];
  for (const href of stylesheetHrefs(html, baseUrl)) {
    try {
      const { html: css } = await fetchPageHtml(href);
      sheets.push(css);
    } catch {
      // skipped
    }
  }
  return sheets;
}
```

**Note the content-type check:** `fetchPageHtml` requires `text/*`, and CSS is served as `text/css`, so stylesheets pass. If a real sheet is ever rejected for content-type, widen the check inside `fetchStylesheets` only — never loosen it for `fetchPageText`.

- [ ] **Step 5: Verify**

Run: `npx vitest run tests/fetch-page.test.ts` — all pass, **including every pre-existing case unedited**. Run `npx vitest run` — all pass. `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add lib/fetch-page.ts tests/fetch-page.test.ts
git commit -m "feat: share the page fetch and read linked stylesheets"
```

---

### Task 3: Schema, prompts, and the extraction wiring

**Files:**
- Create: `supabase/migrations/0016_brand_design_tokens.sql`
- Modify: `lib/types.ts`, `lib/athena/prompts.ts`, `app/api/brand/extract/route.ts`, `app/(app)/config/actions.ts`
- Test: `tests/prompts.test.ts` (extend)

**Interfaces:**
- Consumes: `parseDesignCandidates` (Task 1); `fetchPageHtml`, `fetchStylesheets` (Task 2).
- Produces: `BrandProfile.colors: string[]`, `.fonts: string[]`, `.visual_notes: string`; the same three on `BrandContext`; `BrandExtractOutput` gains them.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0016_brand_design_tokens.sql
-- Design identity scraped from the brand's own site. Until now the only
-- visual signal reaching a post was categories.style_ref_url — an image —
-- so every drafted style_guide described a look in generic prose.

-- Hex strings, most prominent first.
alter table brand_profiles add column colors jsonb not null default '[]'::jsonb;

-- Font family names.
alter table brand_profiles add column fonts jsonb not null default '[]'::jsonb;

-- Anything else worth carrying: imagery style, logo treatment.
alter table brand_profiles add column visual_notes text not null default '';
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/prompts.test.ts` (its existing brand fixtures need `colors: [], fonts: [], visual_notes: ""` added — mechanical):

```ts
describe("brandBlock — visual identity", () => {
  const base = {
    business_name: "Athena", business_description: "SAT prep",
    audience: "parents", voice: "warm", avoid: "AI jargon",
    proof_points: [] as string[], standing: [] as string[],
    colors: [] as string[], fonts: [] as string[], visual_notes: "",
  };

  it("is byte-identical to the pre-visual output when all three are empty", () => {
    expect(brandBlock(base)).toBe(
      [
        "Business: Athena",
        "What it is: SAT prep",
        "Primary audience: parents",
        "Voice / tone: warm",
        "Never lead with / avoid: AI jargon",
      ].join("\n"),
    );
  });

  it("carries colors and fonts when set", () => {
    const p = brandBlock({ ...base, colors: ["#0f172a", "#f97316"], fonts: ["Inter"] });
    expect(p).toContain("#0f172a");
    expect(p).toContain("Inter");
  });

  it("says the visual identity is a default a post type may override", () => {
    const p = brandBlock({ ...base, colors: ["#0f172a"] });
    expect(p.toLowerCase()).toContain("override");
  });

  it("carries visual_notes alone", () => {
    expect(brandBlock({ ...base, visual_notes: "Photography, never illustration." }))
      .toContain("Photography, never illustration.");
  });
});

describe("buildBrandExtractSystemPrompt — design tokens", () => {
  const p = buildBrandExtractSystemPrompt();
  it("explains the candidates are unjudged", () => {
    expect(p.toLowerCase()).toContain("candidate");
  });
  it("forbids inventing a palette", () => {
    expect(p.toLowerCase()).toContain("do not invent");
  });
});
```

- [ ] **Step 3: Implement types and `brandBlock`**

`lib/types.ts` — `BrandProfile` gains `colors: string[]; fonts: string[]; visual_notes: string;`.

`lib/athena/prompts.ts` — `BrandContext` gains the same three. `brandBlock` appends **only when non-empty** (this preserves the byte-identical guarantee), after the standing block:

```ts
  if (brand.colors.length || brand.fonts.length || brand.visual_notes.trim()) {
    lines.push("", "VISUAL IDENTITY — the brand's own look, taken from its site:");
    if (brand.colors.length) lines.push(`- Palette: ${brand.colors.join(", ")}`);
    if (brand.fonts.length) lines.push(`- Type: ${brand.fonts.join(", ")}`);
    if (brand.visual_notes.trim()) lines.push(`- Notes: ${brand.visual_notes.trim()}`);
    lines.push(
      "Use these as the DEFAULT look for anything visual. A specific post type may deliberately override them — a meme format in corporate brand colors would be wrong — so treat them as the starting point, not a rule.",
    );
  }
```

Every `BrandContext` construction site must now supply the three fields; `npx tsc --noEmit` is the authority on the list. Fill from the loaded brand row with `?? []` / `?? ""`, matching how the existing fields already default.

- [ ] **Step 4: Extend the extraction schema and prompt**

`BrandExtractOutput` gains:
```ts
  colors: z.array(z.string()).describe("hex colors that are genuinely this brand's, most prominent first; empty array if the candidates show none"),
  fonts: z.array(z.string()).describe("font families this brand actually uses; empty array if unclear"),
  visual_notes: z.string().describe("one short line on the visual style — imagery, logo treatment — or empty string"),
```

`buildBrandExtractSystemPrompt` gains a section:
```
"DESIGN CANDIDATES:",
"When candidates are provided they are UNJUDGED — scraped from the site's markup and CSS and ranked by a crude heuristic. Most are noise: shadows, borders, grays, framework defaults. Your job is to pick the few that are actually the brand's, in order of prominence, and discard the rest.",
"Do not invent a palette or a typeface. If the candidates don't show a clear brand identity, return empty arrays — that is the correct answer, exactly as it is for proof points.",
```

- [ ] **Step 5: Wire the route**

`app/api/brand/extract/route.ts` — replace the `fetchPageText(url)` call with the shared fetch, so one page load serves both:

```ts
      try {
        const { html, finalUrl } = await fetchPageHtml(url);
        pageText = extractReadableText(html);
        const sheets = await fetchStylesheets(html, finalUrl);
        designCandidates = parseDesignCandidates(html, sheets);
      } catch (e) {
        warnings.push(`Couldn't read ${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
```
(import `extractReadableText` alongside the others). When `designCandidates` has any entries, add a content block before the website text:
```ts
      ...(designCandidates && (designCandidates.colors.length || designCandidates.fonts.length)
        ? [{ type: "text" as const, text: `DESIGN CANDIDATES (unjudged, ranked):\n${JSON.stringify(designCandidates)}` }]
        : []),
```

`app/(app)/config/actions.ts` — `saveBrandProfile` persists `colors: parseBrandList(formData.get("colors"))`, `fonts: parseBrandList(formData.get("fonts"))`, and `visual_notes: String(formData.get("visual_notes") ?? "").trim()`.

- [ ] **Step 6: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean (proves every `BrandContext` site was updated). `npm run build` — clean.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0016_brand_design_tokens.sql lib/types.ts lib/athena/prompts.ts app/api/brand/extract/route.ts "app/(app)/config/actions.ts" tests/prompts.test.ts lib/athena/generate-ideas.ts lib/athena/preview.ts app/api/posts/rewrite-caption/route.ts app/api/posts/adapt-caption/route.ts app/api/categories/draft/route.ts
git commit -m "feat: brand visual identity in the schema, prompts, and extraction"
```

---

### Task 4: The brand form surface

**Files:**
- Create: `app/(app)/config/color-list-editor.tsx`
- Modify: `app/(app)/config/brand-section.tsx`

**Interfaces:**
- Consumes: `BrandListEditor` and the proposal/merge machinery already in `brand-section.tsx`; `BrandDraft` (extended with the three new fields).
- Produces: `ColorListEditor` — same props shape as `BrandListEditor` (`{ label, hint, items, onChange }`), rendering a swatch beside each value.

- [ ] **Step 1: Build the color editor**

`color-list-editor.tsx` — a client component mirroring `BrandListEditor`'s structure and props exactly, with one addition: each row renders a small square swatch (`style={{ backgroundColor: item }}`) beside its text input, with a neutral checkerboard/dashed border when the value isn't a valid hex so a typo is obvious. Read `brand-list-editor.tsx` first and follow it — this is that component plus a swatch, not a redesign.

- [ ] **Step 2: Extend the brand form**

`brand-section.tsx`:
- `BrandDraft` and the form state gain `colors: string[]`, `fonts: string[]`, `visual_notes: string`.
- Render a section headed **"Found on your site — check these"** (the honest label from spec §6, not "your brand colors are") containing `ColorListEditor` for colors, `BrandListEditor` for fonts, and a `Textarea` for visual notes.
- Serialize `colors` and `fonts` as JSON into hidden inputs named `colors`/`fonts`, exactly as `proof_points`/`standing` already do; `visual_notes` is an ordinary named textarea.
- The three new fields join the existing proposal/merge flow unchanged: lists merge via `mergeList`, `visual_notes` fills if empty and stages a proposal if it differs — no new logic, just three more keys.

- [ ] **Step 3: Full battery**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean. `npx eslint app lib components tests scripts` — only the pre-existing warning.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/config/color-list-editor.tsx" "app/(app)/config/brand-section.tsx"
git commit -m "feat: review scraped colors, fonts, and visual notes on the brand form"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §2 (separate extraction path) → Task 2's `fetchPageHtml`; §3 (code finds, model judges — including all five priority sources and the stylesheet cap) → Tasks 1 and 3; §4 (schema) → Task 3; §5 (how they reach a post, byte-identical guarantee, override framing) → Task 3; §6 (honest UI labelling, swatches) → Task 4; §7 (error handling: skipped sheets, empty is correct, malformed CSS) → Tasks 1-3; §8 (testing — each listed fixture maps to a named test) → Tasks 1-3; §9 out-of-scope has no tasks.
- **Type consistency:** `ColorCandidate`/`FontCandidate`/`DesignCandidates`/`parseDesignCandidates`/`normalizeHex`/`normalizeFontFamily`/`fetchPageHtml`/`stylesheetHrefs`/`fetchStylesheets`/`ColorListEditor` match across tasks; `colors`/`fonts`/`visual_notes` are the same three names in the migration, types, schema, prompt, route, and form.
- **The riskiest edit is Task 2's refactor of a twice-regressed file**, so it is isolated in its own task with the existing tests named as the safety net and an explicit instruction not to tidy the guards.
- **Deploy order:** migration 0016 before the code deploys (`saveBrandProfile` writes all three columns immediately).
- **Not CI-verifiable:** whether extraction picks the *right* colors from a real site. After Task 4, run extraction against superset.com and check the swatches against the real brand before trusting it — and note that a Tailwind-compiled site is the hard case the frequency ranking exists for.
