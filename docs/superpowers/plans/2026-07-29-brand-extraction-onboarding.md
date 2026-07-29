# Brand Depth, Extraction, and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model *material* — `proof_points` and `standing` on the brand — plus an extraction flow that drafts a whole brand profile from a website, documents, and/or conversation, and a first-run wizard that chains brand setup into the existing post-type wizard and a first generation.

**Architecture:** The two new fields land on `brand_profiles` and flow into the shared `brandBlock`, so one change reaches every prompt surface (idea generation, the AI filter, caption rewrite, caption adaptation, the post-type wizard) at once — with a byte-identical guarantee when the arrays are empty. Extraction is a stateless BYOK endpoint whose URL fetching is hardened up front. Onboarding is a thin three-step shell that reuses the existing wizard rather than duplicating drafting code.

**Tech Stack:** Next.js App Router (nonstandard — see constraints), Supabase, `@anthropic-ai/sdk` + `zodOutputFormat`, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-brand-extraction-onboarding-design.md`

## Global Constraints

- **`brandBlock`'s output must be byte-identical to today when `proof_points` and `standing` are both empty.** It is shared by six prompt surfaces; a stray newline changes every prompt in the app. There is a test for this.
- **Extraction extracts, it does not invent.** The prompt must forbid fabricating claims the source doesn't support, and an empty `proof_points` array must be a valid answer for a thin source.
- **Nothing overwrites hand-written brand values silently.** Extraction drafts into the form; the user saves.
- **URL fetching is hardened in this project, not deferred:** https-only, per-hop redirect validation, private/loopback/link-local hosts rejected, `text/*` content-type required, size-capped by aborting the stream (not buffering then checking).
- BYOK: every Anthropic call uses `requireAnthropicKey(user.id)`; model `process.env.CLAUDE_MODEL || "claude-sonnet-5"`.
- **This is NOT the Next.js you know** (AGENTS.md): mirror existing route/page conventions; check `node_modules/next/dist/docs/` when unsure. Note `/` redirects to `/ideas` — there is no dashboard, so the first-run banner lives on the ideas page.
- Migration 0015 is a file only — applied to Supabase before the code deploys.
- Tests: `npx vitest run` (253 passing at plan time). Battery adds `npx tsc --noEmit`, `npm run build`, and `npx eslint app lib components tests scripts` — **lint those directories, not `.`**, which picks up `.claude/` scratch and reports thousands of unrelated problems. The only expected finding is the pre-existing `scripts/import-athena-legacy.ts` unused-var warning.
- Commit to the working branch from the worktree directory; confirm with `git rev-parse --abbrev-ref HEAD` before committing.

---

### Task 1: Schema, types, and material in the shared brand block

**Files:**
- Create: `supabase/migrations/0015_brand_material.sql`
- Modify: `lib/types.ts` (`BrandProfile`)
- Modify: `lib/athena/prompts.ts` (`BrandContext`, `brandBlock`)
- Modify: `app/(app)/config/actions.ts` (`saveBrandProfile`)
- Create: `lib/brand.ts` (validation helper)
- Test: `tests/prompts.test.ts` (extend), `tests/brand.test.ts`

**Interfaces:**
- Produces (every later task consumes these):
  - `BrandProfile.proof_points: string[]`, `BrandProfile.standing: string[]`
  - `BrandContext.proof_points: string[]`, `BrandContext.standing: string[]`
  - `export function parseBrandList(raw: unknown): string[]` in `lib/brand.ts` — accepts an array of strings or a JSON string of one, trims, drops empties, caps at 50 items; throws `Error` on a non-array/non-string-item shape.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0015_brand_material.sql
-- Brand depth (spec 2026-07-29-brand-extraction-onboarding-design.md).
-- The model already gets tone and audience but no MATERIAL, which is why
-- generic output is the failure mode. These two arrays are the material.

-- Concrete claims the brand can point at, each a short string —
-- e.g. "5,000 students raised scores 120+ points".
alter table brand_profiles add column proof_points jsonb not null default '[]'::jsonb;

-- Topics the brand has authority to speak on. Generation declines angles
-- outside this when it is non-empty.
alter table brand_profiles add column standing jsonb not null default '[]'::jsonb;
```

- [ ] **Step 2: Write the failing tests**

Create `tests/brand.test.ts`:

```ts
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
```

Append to `tests/prompts.test.ts` (the file's existing `brand` fixture will need `proof_points: []`, `standing: []` added — mechanical):

```ts
describe("brandBlock — material", () => {
  const base = {
    business_name: "Athena", business_description: "SAT prep",
    audience: "parents", voice: "warm", avoid: "AI jargon",
    proof_points: [] as string[], standing: [] as string[],
  };

  it("is byte-identical to the pre-material output when both lists are empty", () => {
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

  it("still returns the no-profile fallback for a wholly empty brand", () => {
    expect(
      brandBlock({
        business_name: "", business_description: "", audience: "", voice: "", avoid: "",
        proof_points: [], standing: [],
      }),
    ).toBe("(No brand profile set yet — keep it generic and on-topic.)");
  });

  it("lists proof points as material when present", () => {
    const p = brandBlock({ ...base, proof_points: ["5,000 students up 120+ pts", "Founded by a 1590 scorer"] });
    expect(p).toContain("5,000 students up 120+ pts");
    expect(p).toContain("Founded by a 1590 scorer");
    expect(p.toLowerCase()).toContain("material");
  });

  it("lists standing when present", () => {
    const p = brandBlock({ ...base, standing: ["test prep", "study habits"] });
    expect(p).toContain("test prep");
    expect(p).toContain("study habits");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/brand.test.ts tests/prompts.test.ts`
Expected: FAIL — `@/lib/brand` missing; `brandBlock` doesn't carry material.

- [ ] **Step 4: Implement**

`lib/types.ts` — `BrandProfile` gains, after `avoid`:
```ts
  proof_points: string[];
  standing: string[];
```

`lib/brand.ts`:
```ts
const MAX_ITEMS = 50;

// Brand lists arrive either as a real array (the extraction endpoint's
// structured output) or as a JSON string (the brand form posts FormData).
// One parser for both so the two paths cannot disagree about shape.
export function parseBrandList(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(value)) throw new Error("expected an array of strings");
  for (const item of value) {
    if (typeof item !== "string") throw new Error("expected an array of strings");
  }
  return (value as string[]).map((s) => s.trim()).filter(Boolean).slice(0, MAX_ITEMS);
}
```

`lib/athena/prompts.ts` — `BrandContext` gains `proof_points: string[];` and `standing: string[];`. `brandBlock` appends AFTER its existing five lines, and **only when the arrays are non-empty** (this is what preserves the byte-identical guarantee):

```ts
export function brandBlock(brand: BrandContext): string {
  const lines: string[] = [];
  if (brand.business_name) lines.push(`Business: ${brand.business_name}`);
  if (brand.business_description) lines.push(`What it is: ${brand.business_description}`);
  if (brand.audience) lines.push(`Primary audience: ${brand.audience}`);
  if (brand.voice) lines.push(`Voice / tone: ${brand.voice}`);
  if (brand.avoid) lines.push(`Never lead with / avoid: ${brand.avoid}`);
  // The material. Ground ideas in these specifics rather than generic
  // claims — a brand with proof points and no instruction to use them
  // still produces the generic output this exists to fix.
  if (brand.proof_points.length) {
    lines.push(
      "",
      "MATERIAL — concrete things this brand can point at. Ground ideas in these specifics rather than generic benefits:",
      ...brand.proof_points.map((p) => `- ${p}`),
    );
  }
  if (brand.standing.length) {
    lines.push(
      "",
      `STANDING — this brand has authority to speak on: ${brand.standing.join(", ")}.`,
      "Decline angles outside that; do not claim expertise it has not earned.",
    );
  }
  return lines.length ? lines.join("\n") : "(No brand profile set yet — keep it generic and on-topic.)";
}
```

`app/(app)/config/actions.ts` — `saveBrandProfile`'s upsert gains, inside a try/catch that returns `{ error }` on a parse failure:
```ts
      proof_points: parseBrandList(formData.get("proof_points")),
      standing: parseBrandList(formData.get("standing")),
```

Every construction site of `BrandContext` must now supply both arrays or tsc fails — there are five (`lib/athena/generate-ideas.ts`, `lib/athena/preview.ts`, `app/api/posts/rewrite-caption/route.ts`, `app/api/posts/adapt-caption/route.ts`, and the draft route). Fill each from the loaded `brandRow` with `?? []`, matching how they already default the string fields.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean (this is what proves every `BrandContext` site was updated). `npm run build` — clean.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0015_brand_material.sql lib/types.ts lib/brand.ts lib/athena/prompts.ts "app/(app)/config/actions.ts" lib/athena/generate-ideas.ts lib/athena/preview.ts app/api/posts/rewrite-caption/route.ts app/api/posts/adapt-caption/route.ts app/api/categories/draft/route.ts tests/brand.test.ts tests/prompts.test.ts
git commit -m "feat: proof points and standing as brand material in every prompt"
```

---

### Task 2: Hardened URL fetching and readable-text extraction

Its own task because it is the security-sensitive part and is entirely pure/testable.

**Files:**
- Create: `lib/fetch-page.ts`
- Test: `tests/fetch-page.test.ts`

**Interfaces:**
- Produces (Task 3 consumes):
  - `export function isBlockedHost(hostname: string): boolean` — true for localhost, loopback, private IPv4 ranges, link-local, and IPv6 loopback/unique-local.
  - `export function assertFetchableUrl(raw: string): URL` — throws unless https and the host is not blocked.
  - `export function extractReadableText(html: string, maxChars?: number): string` — strips script/style/noscript/svg and tags, decodes the common entities, collapses whitespace, truncates (default 20000).
  - `export async function fetchPageText(rawUrl: string): Promise<string>` — validates, fetches with `redirect: "manual"` re-validating each hop (max 3), requires a `text/*` content-type, reads the body with a 2MB abort, returns `extractReadableText`.

- [ ] **Step 1: Write the failing tests**

`tests/fetch-page.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isBlockedHost, assertFetchableUrl, extractReadableText } from "@/lib/fetch-page";

describe("isBlockedHost", () => {
  it("blocks loopback and localhost", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("127.1.2.3")).toBe(true);
    expect(isBlockedHost("::1")).toBe(true);
    expect(isBlockedHost("[::1]")).toBe(true);
  });
  it("blocks private IPv4 ranges", () => {
    expect(isBlockedHost("10.0.0.5")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
  });
  it("allows a public-looking 172 address outside the private block", () => {
    expect(isBlockedHost("172.32.0.1")).toBe(false);
    expect(isBlockedHost("172.15.0.1")).toBe(false);
  });
  it("blocks link-local and metadata addresses", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });
  it("blocks IPv6 unique-local", () => {
    expect(isBlockedHost("fd00::1")).toBe(true);
  });
  it("allows ordinary public hostnames", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("athena.study")).toBe(false);
  });
});

describe("assertFetchableUrl", () => {
  it("accepts an https url", () => {
    expect(assertFetchableUrl("https://example.com/about").hostname).toBe("example.com");
  });
  it("rejects http", () => {
    expect(() => assertFetchableUrl("http://example.com")).toThrow(/https/i);
  });
  it("rejects a blocked host", () => {
    expect(() => assertFetchableUrl("https://127.0.0.1/")).toThrow();
  });
  it("rejects an unparseable url", () => {
    expect(() => assertFetchableUrl("not a url")).toThrow();
  });
});

describe("extractReadableText", () => {
  it("strips script and style content entirely", () => {
    const out = extractReadableText(
      "<html><head><style>.a{color:red}</style></head><body><script>alert(1)</script><p>Hello</p></body></html>",
    );
    expect(out).toContain("Hello");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("alert");
  });
  it("strips tags but keeps their text, separated", () => {
    expect(extractReadableText("<h1>Title</h1><p>Body</p>")).toBe("Title Body");
  });
  it("decodes common entities", () => {
    expect(extractReadableText("<p>Tom &amp; Jerry &mdash; &quot;hi&quot;</p>")).toContain("Tom & Jerry");
  });
  it("collapses whitespace", () => {
    expect(extractReadableText("<p>a\n\n   b</p>")).toBe("a b");
  });
  it("truncates to the cap", () => {
    expect(extractReadableText(`<p>${"x".repeat(500)}</p>`, 100)).toHaveLength(100);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fetch-page.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

`lib/fetch-page.ts`:

```ts
import "server-only";

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_CHARS = 20_000;

// Hostname-level SSRF guard. This blocks literal private addresses and
// obvious loopback names; it does NOT resolve DNS, so a public hostname
// that resolves to a private address still gets through. That residual is
// accepted here: this endpoint is authenticated, the deployment is Vercel
// serverless (no metadata endpoint, no private service network), and the
// only output is text handed to an LLM.
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;      // IPv6 unique-local
  if (/^fe80:/i.test(host)) return true;                   // IPv6 link-local
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;               // link-local + metadata
  }
  return false;
}

export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Not a valid URL: ${raw.slice(0, 80)}`);
  }
  if (url.protocol !== "https:") throw new Error("Only https URLs can be read");
  if (isBlockedHost(url.hostname)) throw new Error("That host isn't reachable from here");
  return url;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
};

export function extractReadableText(html: string, maxChars = DEFAULT_MAX_CHARS): string {
  const stripped = html
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  const decoded = stripped
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ");
  return decoded.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

// Fetches a page's readable text with redirects validated per hop — the
// initial URL being https and public is not enough, since a redirect can
// otherwise land on http or a private address.
export async function fetchPageText(rawUrl: string): Promise<string> {
  let url = assertFetchableUrl(rawUrl);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(url, { redirect: "manual", headers: { accept: "text/html,text/plain" } });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect with no location (HTTP ${res.status})`);
      url = assertFetchableUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!res) throw new Error("No response");
  if (res.status >= 300 && res.status < 400) throw new Error("Too many redirects");
  if (!res.ok) throw new Error(`Could not read that page (HTTP ${res.status})`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/")) {
    throw new Error(`That URL isn't a web page (${contentType.split(";")[0] || "unknown type"})`);
  }

  // Read incrementally and abort past the cap rather than buffering a
  // gigabyte first and checking afterwards.
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("That page is too large to read");
      }
      chunks.push(value);
    }
  }
  const html = new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const merged = new Uint8Array(acc.length + c.length);
      merged.set(acc);
      merged.set(c, acc.length);
      return merged;
    }, new Uint8Array()),
  );
  return extractReadableText(html);
}
```

Note `import "server-only"` — the tests import only the pure exports, so `tests/fetch-page.test.ts` needs `vi.mock("server-only", () => ({}))` at the top, matching what `tests/preview.test.ts` already does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/fetch-page.test.ts` — PASS. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/fetch-page.ts tests/fetch-page.test.ts
git commit -m "feat: hardened page fetching and readable-text extraction"
```

---

### Task 3: The extraction endpoint

**Files:**
- Modify: `lib/athena/prompts.ts` (extraction prompt builder + output schema)
- Create: `app/api/brand/extract/route.ts`
- Test: `tests/prompts.test.ts` (extend)

**Interfaces:**
- Consumes: `fetchPageText` (Task 2); `BrandContext` (Task 1); `requireAnthropicKey`; `createServerSupabase`; the route conventions in `app/api/posts/adapt-caption/route.ts`.
- Produces:
  - `export const BrandExtractOutput` (zod): `{ business_name, business_description, audience, voice, avoid, proof_points: string[], standing: string[] }`
  - `export function buildBrandExtractSystemPrompt(): string`
  - `POST /api/brand/extract` — `{ url?: string, documentUrls?: string[], turns?: {role:"user"|"assistant", text:string}[] }` → the draft object; 401 / 400 (no usable input) / 500 with message passthrough. Also returns `{ warnings: string[] }` naming any input that failed so a bad URL doesn't sink a run that had documents.

- [ ] **Step 1: Write the failing test**

Append to `tests/prompts.test.ts`:

```ts
import { buildBrandExtractSystemPrompt } from "@/lib/athena/prompts";

describe("buildBrandExtractSystemPrompt", () => {
  const p = buildBrandExtractSystemPrompt();
  it("asks for concrete material, not adjectives", () => {
    expect(p.toLowerCase()).toContain("specific");
    expect(p.toLowerCase()).toContain("numbers");
  });
  it("forbids inventing claims", () => {
    expect(p.toLowerCase()).toContain("never invent");
  });
  it("says an empty proof_points list is a valid answer", () => {
    expect(p).toContain("empty");
  });
  it("scopes standing to what the sources evidence", () => {
    expect(p.toLowerCase()).toContain("standing");
    expect(p.toLowerCase()).toContain("evidence");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompts.test.ts` — FAIL (`buildBrandExtractSystemPrompt` not exported).

- [ ] **Step 3: Implement the prompt and schema**

In `lib/athena/prompts.ts`:

```ts
export const BrandExtractOutput = z.object({
  business_name: z.string().describe("the business's name, empty string if the sources don't say"),
  business_description: z.string().describe("one or two sentences on what it actually is"),
  audience: z.string().describe("who it is for"),
  voice: z.string().describe("how it sounds — tone, register, characteristic moves"),
  avoid: z.string().describe("words, claims, or framings this brand should never lead with"),
  proof_points: z.array(z.string()).describe(
    "concrete claims the brand can point at, each one short and specific; empty array if the sources support none",
  ),
  standing: z.array(z.string()).describe("topics the sources show this brand has authority to speak on"),
});

export function buildBrandExtractSystemPrompt(): string {
  return [
    "You are building a brand profile from the sources the user provides — a website's text, uploaded documents, and/or a conversation.",
    "",
    "Your job is to extract MATERIAL, not adjectives. The point of this profile is to give a content generator something specific to work with, so:",
    "- Prefer specifics: numbers, named results, dates, credentials, customer names, scale.",
    "- A proof point is something the brand can point at — \"5,000 students raised scores 120+ points\" — not a quality it claims, like \"we care about results\".",
    "- NEVER invent a claim the sources do not support. Returning an empty proof_points array is the correct answer for a thin source; a fabricated one is not.",
    "- standing lists only topics the sources actually evidence expertise in. If the sources show a tutoring service, standing is test prep and study habits — not education policy.",
    "",
    "voice describes how the brand sounds, in a way another writer could imitate. avoid captures what it should never lead with — jargon, claims it can't back, or framings that would read wrong for its audience.",
    "",
    "Leave a field as an empty string when the sources genuinely don't say. Do not pad.",
  ].join("\n");
}
```

- [ ] **Step 4: Write the route**

`app/api/brand/extract/route.ts` — mirror `app/api/posts/adapt-caption/route.ts`'s structure:

```ts
import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { BrandExtractOutput, buildBrandExtractSystemPrompt } from "@/lib/athena/prompts";
import { fetchPageText } from "@/lib/fetch-page";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : null;
  const documentUrls: string[] = Array.isArray(body?.documentUrls)
    ? body.documentUrls.filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://")).slice(0, 5)
    : [];
  const turns: { role: "user" | "assistant"; text: string }[] = Array.isArray(body?.turns)
    ? body.turns.filter((t: unknown) => {
        const turn = t as { role?: unknown; text?: unknown };
        return (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string";
      })
    : [];
  if (!url && !documentUrls.length && !turns.length) {
    return NextResponse.json(
      { error: "Give it something to read — a website, a document, or a description." },
      { status: 400 },
    );
  }

  const warnings: string[] = [];
  try {
    let pageText = "";
    if (url) {
      try {
        pageText = await fetchPageText(url);
      } catch (e) {
        warnings.push(`Couldn't read ${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Documents ride as native attachments — Claude reads PDFs directly,
    // which matters because decks and one-pagers carry the proof points.
    const content: Anthropic.ContentBlockParam[] = [
      ...documentUrls.map((u) =>
        u.toLowerCase().endsWith(".pdf")
          ? ({ type: "document" as const, source: { type: "url" as const, url: u } })
          : ({ type: "image" as const, source: { type: "url" as const, url: u } }),
      ),
      ...(pageText ? [{ type: "text" as const, text: `WEBSITE TEXT (${url}):\n${pageText}` }] : []),
      ...(turns.length
        ? [{ type: "text" as const, text: `WHAT THE USER TOLD YOU:\n${turns.map((t) => `${t.role}: ${t.text}`).join("\n")}` }]
        : []),
    ];
    if (!content.length) {
      return NextResponse.json({ error: warnings[0] ?? "Nothing readable was provided." }, { status: 400 });
    }

    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id) });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: buildBrandExtractSystemPrompt(),
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(BrandExtractOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) throw new Error(`extraction returned no parseable output (stop_reason: ${response.stop_reason})`);
    return NextResponse.json({ ...parsed, warnings });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("brand extraction failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

If the installed SDK's content-block type name differs from `Anthropic.ContentBlockParam`, or it has no `document` block type, adapt: fall back to passing PDFs as `image` blocks is NOT valid — instead drop unsupported types into `warnings` and note it in the report.

- [ ] **Step 5: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean (route registered).

- [ ] **Step 6: Commit**

```bash
git add lib/athena/prompts.ts app/api/brand/extract/route.ts tests/prompts.test.ts
git commit -m "feat: brand extraction endpoint reading url, documents, and conversation"
```

---

### Task 4: The brand form as a review surface

**Files:**
- Create: `app/(app)/config/brand-list-editor.tsx`
- Create: `app/(app)/config/brand-extract-panel.tsx`
- Modify: `app/(app)/config/brand-section.tsx`

**Interfaces:**
- Consumes: `POST /api/brand/extract` (Task 3), `parseBrandList` (Task 1), `uploadStyleRefImage` (existing server action in `app/(app)/config/actions.ts`, FormData field `"file"`, returns `{url?, error?}` — reuse it for documents).
- Produces:
  - `export function BrandListEditor(props: { label: string; hint: string; items: string[]; onChange(items: string[]): void }): JSX.Element`
  - `export function BrandExtractPanel(props: { onDraft(draft: BrandDraft): void }): JSX.Element` where `export interface BrandDraft { business_name: string; business_description: string; audience: string; voice: string; avoid: string; proof_points: string[]; standing: string[] }`

- [ ] **Step 1: Build the list editor**

`brand-list-editor.tsx` — a client component: renders `items` as rows, each an `Input` bound to that index plus a remove (×) button; an "+ Add" button appends `""`; empty rows are dropped on blur. Label and hint above. Follow the repo's client idioms (`app/(app)/config/category-manager.tsx` for shadcn usage).

- [ ] **Step 2: Build the extraction panel**

`brand-extract-panel.tsx` — a client component with three inputs in one card:
- **Website** — an `Input` for a URL.
- **Documents** — a file input (accept `.pdf,image/*`, `multiple`) uploading each through `uploadStyleRefImage`, showing the uploaded filenames with remove buttons.
- **Describe it** — a `Textarea` for free text, sent as a single `{role:"user"}` turn.

A "Read this and draft my brand" button POSTs to `/api/brand/extract`, disabled while pending or when all three inputs are empty. On success it calls `onDraft(draft)` and renders any `warnings` as non-blocking amber lines. On failure it shows the error inline and leaves inputs intact.

- [ ] **Step 3: Rework the brand section**

`brand-section.tsx` becomes a controlled client form (it currently uses `defaultValue` + `useActionState`):
- Hold all seven fields in state, initialized from `brand`.
- Render the five existing inputs bound to state, plus two `BrandListEditor`s for proof points and standing.
- Serialize the two arrays as JSON into hidden inputs named `proof_points` and `standing` so the existing FormData action receives them (`parseBrandList` already accepts a JSON string — that is why it does).
- Mount `BrandExtractPanel`. `onDraft` **does not overwrite silently**: for each field where the draft differs from the current value AND the current value is non-empty, show the proposed value with Keep/Use buttons; fields that are currently empty are filled directly. Proof points and standing merge as: existing items retained, new items appended with an "added" marker until saved.
- Keep the existing save button and its `state.ok` / `state.error` display.

- [ ] **Step 4: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean. `npx eslint app lib components tests scripts` — only the pre-existing warning.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config/brand-list-editor.tsx" "app/(app)/config/brand-extract-panel.tsx" "app/(app)/config/brand-section.tsx"
git commit -m "feat: brand form with material lists and AI extraction"
```

---

### Task 5: Onboarding wizard and first-run banner

**Files:**
- Create: `app/(app)/onboarding/page.tsx`
- Create: `app/(app)/onboarding/onboarding-steps.tsx`
- Modify: `app/(app)/ideas/page.tsx` (first-run banner)
- Modify: `app/(app)/config/page.tsx` (re-entry link)

**Interfaces:**
- Consumes: `BrandExtractPanel` + `BrandSection` (Task 4); the existing `/config/draft` wizard; the existing `/api/ideas/generate` route (`{ categoryKey, count }`).

- [ ] **Step 1: Build the server page**

`app/(app)/onboarding/page.tsx` — read `app/(app)/config/page.tsx` first for this Next version's conventions. It: `requireUser()`; loads the user's `brand_profiles` row and their categories; computes three booleans — `brandDone` (a row exists with a non-empty `business_name`), `categoryDone` (at least one active category), `ideasDone` (at least one row in `ideas`); passes them to the client component along with the first active category's key.

- [ ] **Step 2: Build the steps client**

`onboarding-steps.tsx` — three numbered cards, each showing done / current / upcoming state:
1. **Brand** — renders the same `BrandExtractPanel` plus the brand form fields (import and reuse `BrandSection` rather than duplicating it). Done when `brandDone`.
2. **First post type** — a "Draft a post type" button linking to `/config/draft`, and a line explaining it opens the same wizard used later from Config. Done when `categoryDone`.
3. **First ideas** — a button POSTing to `/api/ideas/generate` with the first active category's key and `count: 5`, then routing to `/ideas` on success. Disabled until step 2 is done; shows the API's error inline on failure. Done when `ideasDone`.

The first incomplete step is expanded; completed ones collapse to a check and a title. A "Skip for now" link returns to `/ideas`.

- [ ] **Step 3: Add the first-run banner**

`app/(app)/ideas/page.tsx` — the page already loads categories; also load the brand row. When there is no brand row or its `business_name` is empty, render a prominent card above the ideas list: "Set up your brand — the generator works from what you tell it about your business" with a link to `/onboarding`. It renders nothing once a brand exists. (`/` redirects to `/ideas`, so this is the landing surface.)

- [ ] **Step 4: Add the Config re-entry**

`app/(app)/config/page.tsx` — a small "Run setup again" link to `/onboarding` near the brand section, so the wizard is reachable after dismissal.

- [ ] **Step 5: Full battery**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean. `npx eslint app lib components tests scripts` — only the pre-existing warning.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/onboarding" "app/(app)/ideas/page.tsx" "app/(app)/config/page.tsx"
git commit -m "feat: three-step onboarding wizard and first-run banner"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §2 → Task 1; §3 → Tasks 2 (fetching) and 3 (endpoint); §4 → Task 4; §5 → Task 5; §6 → Task 1 (`brandBlock`); §7 error handling → Tasks 3-5 (warnings array, inline errors, non-blocking failures); §8 testing → Tasks 1-3 (§8's five items each map to a test block; the form and wizard are UI, untested per repo convention); §9 out-of-scope has no tasks.
- **Type consistency:** `parseBrandList`, `BrandContext.proof_points`/`.standing`, `isBlockedHost`/`assertFetchableUrl`/`extractReadableText`/`fetchPageText`, `BrandExtractOutput`/`buildBrandExtractSystemPrompt`, `BrandDraft`/`BrandListEditor`/`BrandExtractPanel` all match across tasks.
- **The byte-identical guarantee** is asserted with an exact `toBe` on the joined string, not a `toContain` — a weaker assertion would let a stray newline through and silently shift six prompts.
- **Verify-at-execution items (deliberate):** the SDK's content-block type names for PDF attachments (Task 3 Step 4, with an explicit instruction not to fake it); this Next version's page conventions (Tasks 3 and 5, read the existing page first).
- **Deploy order:** migration 0015 before the code deploy (`saveBrandProfile` writes both columns immediately).
- **Not CI-verifiable:** extraction quality against a real site, and whether the material actually improves idea specificity. After Task 5 the human should run extraction against a real business site, check the proof points are real rather than invented, then generate a batch and compare specificity against the previous output.
