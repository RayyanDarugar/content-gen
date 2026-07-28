# AI-Assisted Post-Type Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A conversational wizard ("describe it" or "show it" via screenshot) that drafts `categories` rows — the same fields the manual `CategoryEditor` renders — with continuous upsert per turn and an optional real-generation test preview that touches no other tables.

**Architecture:** Client-held multi-turn conversation posted to a new API route; every assistant turn is one structured-output object (`zodOutputFormat`, same mechanism as `IdeasOutput`) that upserts the category row (`active: false` on create). The test preview reuses the existing pure functions `uploadStyleRef` / `buildSlidePrompt` / `createKieTask` / `getKieRecord` and writes nothing to `ideas`/`generations` — the client orchestrates anchor → fan-out and polls a stateless status endpoint.

**Tech Stack:** Next.js App Router (nonstandard version — see constraints), `@anthropic-ai/sdk` with `zodOutputFormat`, Supabase (RLS server client), Kie.ai, Cloudinary (existing `uploadStyleRefImage` action), vitest.

**Spec:** `docs/superpowers/specs/2026-07-27-ai-assisted-post-type-authoring-design.md`

## Global Constraints

- **No new tables, no migrations.** Every field the wizard writes already exists on `categories`.
- **The preview writes nothing to `ideas` or `generations`** — no DB row of any kind is created for a preview (spec §6).
- **BYOK only:** every Anthropic call uses `requireAnthropicKey(userId)`, every Kie call uses `requireKieKey(userId)` (`lib/settings/user-secrets.ts`). Never an env-var API key.
- **The LLM output schema never contains** `style_ref_url`, `post_caption`, `buffer_channel_id`, `active`, or `key`. The model drafts only: `name`, `style_guide`, `output_format`, `post_type`, `role_guides`, `images_per_carousel`, `aspect_ratio`.
- **Create always sets `active: false`.** The wizard never activates a category.
- **Update turns write only the drafted columns** (plus `style_ref_url` when the user uploaded a new brand reference that turn). `key` is immutable after creation (matches existing `updateCategory`, which never touches `key`).
- **Screenshot prompt hard requirement (spec §3):** the system prompt must direct the model to extract *structure and copy pattern only* from a screenshot and must contain explicit never-copy language for palette/fonts/photography/illustration style.
- **Model id:** `process.env.CLAUDE_MODEL || "claude-sonnet-5"`. Keep `max_tokens` ≤ 16000 (SDK non-streaming ceiling — see comment atop `lib/athena/generate-ideas.ts`).
- **This is NOT the Next.js you know** (AGENTS.md): before writing any page or route handler, check the relevant guide in `node_modules/next/dist/docs/` and mirror the existing patterns in `app/api/ideas/generate/route.ts` and `app/(app)/config/page.tsx` (e.g. whether `searchParams` is a Promise).
- **`npx eslint .` has one pre-existing failure** — `app/(app)/post/post-composer.tsx:34` `react-hooks/set-state-in-effect` (followups doc §4). Do NOT fix it; it is out of scope. "Lint passes" for this plan means no *new* errors.
- Run tests with `npx vitest run <file>` (repo already uses vitest; `tests/prompts.test.ts` is the style reference).

---

### Task 1: Extract shared category field validation into `lib/categories.ts`

`validateFields` and `slugify` are currently private to `app/(app)/config/actions.ts`, which is a `"use server"` module and can only export async functions. The draft route needs both. Move them (verbatim bodies) to a plain module, and move the `CategoryFields` interface with them.

**Files:**
- Create: `lib/categories.ts`
- Create: `tests/categories.test.ts`
- Modify: `app/(app)/config/actions.ts` (delete the moved code, import it; keep `export interface CategoryFields` OUT — it moves)
- Modify: `app/(app)/config/category-manager.tsx:13` (import `CategoryFields` from `@/lib/categories` instead of `./actions`)

**Interfaces:**
- Consumes: `PostType`, `RoleGuides` from `@/lib/types` (existing).
- Produces (later tasks import these exact names):
  - `export interface CategoryFields { name: string; style_guide: string; output_format: string; style_ref_url: string; post_caption: string; buffer_channel_id: string; images_per_carousel: number; aspect_ratio: string; active: boolean; post_type: PostType; role_guides: RoleGuides; }`
  - `export function validateCategoryFields(f: CategoryFields): void` — throws `Error` on invalid input, returns nothing on valid.
  - `export function slugify(name: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/categories.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/categories.test.ts`
Expected: FAIL — cannot resolve `@/lib/categories`.

- [ ] **Step 3: Create `lib/categories.ts` with the moved code**

Copy the bodies **verbatim** from `app/(app)/config/actions.ts` (the `CategoryFields` interface, the `SLIDE_ROLES` set, `validateFields` renamed to `validateCategoryFields`, and `slugify`):

```ts
import type { PostType, RoleGuides } from "@/lib/types";

export interface CategoryFields {
  name: string;
  style_guide: string;
  output_format: string;
  style_ref_url: string;
  post_caption: string;
  buffer_channel_id: string;
  images_per_carousel: number;
  aspect_ratio: string;
  active: boolean;
  post_type: PostType;
  role_guides: RoleGuides;
}

const SLIDE_ROLES = new Set(["hook", "beat", "payoff", "single"]);

export function validateCategoryFields(f: CategoryFields) {
  if (!f.name.trim()) throw new Error("Name is required");
  if (!Number.isInteger(f.images_per_carousel) || f.images_per_carousel < 1 || f.images_per_carousel > 10) {
    throw new Error("images_per_carousel must be 1-10");
  }
  if (f.post_type !== "independent" && f.post_type !== "narrative") {
    throw new Error("post_type must be independent or narrative");
  }
  // A narrative carousel needs at least a hook and a payoff to be a story.
  if (f.post_type === "narrative" && f.images_per_carousel < 2) {
    throw new Error("A narrative post needs at least 2 slides — use independent for single images");
  }
  // role_guides is written straight to jsonb; validate it here rather than
  // letting a bad value throw later at generation time when
  // roleGuides[slide.role]?.trim() runs against a non-string.
  for (const [role, guide] of Object.entries(f.role_guides ?? {})) {
    if (!SLIDE_ROLES.has(role)) throw new Error(`role_guides has an unknown role "${role}"`);
    if (typeof guide !== "string") throw new Error(`role_guides.${role} must be a string`);
  }
}

export function slugify(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "CATEGORY";
}
```

Then in `app/(app)/config/actions.ts`: delete the local `CategoryFields` interface, `SLIDE_ROLES`, `validateFields`, and `slugify`; add `import { type CategoryFields, validateCategoryFields, slugify } from "@/lib/categories";` and replace the two `validateFields(fields)` call sites (in `createCategory` and `updateCategory`) with `validateCategoryFields(fields)`. The `import type { PostType, RoleGuides } from "@/lib/types"` line in actions.ts becomes unused — remove it.

In `app/(app)/config/category-manager.tsx`, change the import at the top:

```ts
import {
  createCategory, updateCategory, deleteCategory, uploadStyleRefImage,
} from "./actions";
import type { CategoryFields } from "@/lib/categories";
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/categories.test.ts` — expected: PASS.
Run: `npx tsc --noEmit` — expected: no errors (if the repo has no tsc script, `npm run build` is the fallback typecheck; only needed once here, later tasks build anyway).

- [ ] **Step 5: Commit**

```bash
git add lib/categories.ts tests/categories.test.ts "app/(app)/config/actions.ts" "app/(app)/config/category-manager.tsx"
git commit -m "refactor: extract category field validation to lib/categories"
```

---

### Task 2: Drafting schema, system prompt, and message mappers (`lib/athena/draft-category.ts`)

The pure heart of the feature: the zod output schema for a conversation turn, the system prompt (brand context + field rules + the screenshot constraint), normalization (clamp narrative slide count, default empty name, strip empty role guides), and the mapping from client-held turns to Anthropic messages. All pure and unit-testable. Also exports `brandBlock` from `prompts.ts` (currently private) for reuse.

**Files:**
- Create: `lib/athena/draft-category.ts`
- Create: `tests/draft-category.test.ts`
- Modify: `lib/athena/prompts.ts:12` (`function brandBlock` → `export function brandBlock`; no other change)

**Interfaces:**
- Consumes: `BrandContext`, `brandBlock` from `@/lib/athena/prompts`; `PostType`, `RoleGuides`, `Category` from `@/lib/types`.
- Produces (Tasks 3, 6, 7 import these exact names):
  - `export const DraftTurnOutput` (zod schema; full turn object incl. `assistant_message`)
  - `export interface NormalizedDraft { name: string; style_guide: string; output_format: string; post_type: PostType; role_guides: RoleGuides; images_per_carousel: number; aspect_ratio: string; }`
  - `export interface DraftTurn { role: "user" | "assistant"; text: string; imageUrls?: string[]; draft?: NormalizedDraft; }`
  - `export function normalizeDraft(d: Omit<z.infer<typeof DraftTurnOutput>, "assistant_message">): NormalizedDraft`
  - `export function categoryToDraft(c: Pick<Category, "name" | "style_guide" | "output_format" | "post_type" | "role_guides" | "images_per_carousel" | "aspect_ratio">): NormalizedDraft`
  - `export function buildDraftSystemPrompt(brand: BrandContext, seed?: NormalizedDraft): string`
  - `export function toAnthropicMessages(turns: DraftTurn[]): MessageParam[]`

Do NOT add `import "server-only"` to this file — Task 6's client component type-imports from it.

- [ ] **Step 1: Write the failing tests**

Create `tests/draft-category.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DraftTurnOutput, normalizeDraft, categoryToDraft,
  buildDraftSystemPrompt, toAnthropicMessages,
  type DraftTurn, type NormalizedDraft,
} from "@/lib/athena/draft-category";
import type { BrandContext } from "@/lib/athena/prompts";

const brand: BrandContext = {
  business_name: "Athena",
  business_description: "An SAT prep platform that teaches like a personal tutor.",
  audience: "Parents of high-schoolers",
  voice: "Warm, encouraging, plain-spoken",
  avoid: "AI-powered, dashboards, analytics",
};

const rawDraft = {
  name: "Myth Busters",
  style_guide: "Flat illustration, cream background.",
  output_format: "myth, debunk, insight",
  post_type: "narrative" as const,
  role_guides: { hook: "Orange MYTH tag", beat: "", payoff: "  ", single: "" },
  images_per_carousel: 5,
  aspect_ratio: "4:5",
};

describe("DraftTurnOutput", () => {
  it("parses a full turn object", () => {
    const parsed = DraftTurnOutput.parse({ assistant_message: "Here's a start.", ...rawDraft });
    expect(parsed.name).toBe("Myth Busters");
  });
  it("rejects an unknown post_type", () => {
    expect(() =>
      DraftTurnOutput.parse({ assistant_message: "x", ...rawDraft, post_type: "story" }),
    ).toThrow();
  });
});

describe("normalizeDraft", () => {
  it("strips empty and whitespace-only role guides", () => {
    const d = normalizeDraft(rawDraft);
    expect(d.role_guides).toEqual({ hook: "Orange MYTH tag" });
  });
  it("clamps a narrative to at least 2 slides", () => {
    const d = normalizeDraft({ ...rawDraft, images_per_carousel: 1 });
    expect(d.images_per_carousel).toBe(2);
  });
  it("does not clamp an independent category", () => {
    const d = normalizeDraft({ ...rawDraft, post_type: "independent", images_per_carousel: 1 });
    expect(d.images_per_carousel).toBe(1);
  });
  it("defaults an empty name and aspect ratio", () => {
    const d = normalizeDraft({ ...rawDraft, name: "  ", aspect_ratio: "" });
    expect(d.name).toBe("Untitled draft");
    expect(d.aspect_ratio).toBe("4:5");
  });
});

describe("categoryToDraft", () => {
  it("maps a category row to a draft, defaulting null role_guides", () => {
    const d = categoryToDraft({
      name: "N", style_guide: "S", output_format: "O", post_type: "independent",
      role_guides: null as never, images_per_carousel: 3, aspect_ratio: "9:16",
    });
    expect(d.role_guides).toEqual({});
    expect(d.aspect_ratio).toBe("9:16");
  });
});

describe("buildDraftSystemPrompt", () => {
  it("injects the brand context", () => {
    const p = buildDraftSystemPrompt(brand);
    expect(p).toContain("Athena");
    expect(p).toContain("Parents of high-schoolers");
  });
  it("constrains screenshot extraction to structure, never visual style", () => {
    const p = buildDraftSystemPrompt(brand);
    expect(p).toContain("ONLY structure and copy pattern");
    expect(p).toContain("NEVER copy its colors, palette, fonts");
  });
  it("explains the style_guide vs role_guides split", () => {
    const p = buildDraftSystemPrompt(brand);
    expect(p.toLowerCase()).toContain("every panel");
    expect(p).toContain("single role");
  });
  it("includes the current fields when revising", () => {
    const seed: NormalizedDraft = normalizeDraft(rawDraft);
    const p = buildDraftSystemPrompt(brand, seed);
    expect(p).toContain("revising an existing category");
    expect(p).toContain("Myth Busters");
  });
  it("omits revise framing when starting fresh", () => {
    expect(buildDraftSystemPrompt(brand)).not.toContain("revising an existing category");
  });
});

describe("toAnthropicMessages", () => {
  it("turns user images into image blocks ahead of the text", () => {
    const turns: DraftTurn[] = [
      { role: "user", text: "Like this one", imageUrls: ["https://x/y.png"] },
    ];
    const msgs = toAnthropicMessages(turns);
    expect(msgs[0].role).toBe("user");
    const content = msgs[0].content as { type: string }[];
    expect(content[0].type).toBe("image");
    expect(content[1].type).toBe("text");
  });
  it("serializes assistant turns as the full draft JSON", () => {
    const draft = normalizeDraft(rawDraft);
    const turns: DraftTurn[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "Here you go.", draft },
    ];
    const msgs = toAnthropicMessages(turns);
    const parsed = JSON.parse(msgs[1].content as string);
    expect(parsed.assistant_message).toBe("Here you go.");
    expect(parsed.name).toBe("Myth Busters");
  });
  it("substitutes placeholder text for an empty user message", () => {
    const msgs = toAnthropicMessages([{ role: "user", text: "", imageUrls: ["https://x/y.png"] }]);
    const content = msgs[0].content as { type: string; text?: string }[];
    expect(content[1].text).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/draft-category.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/draft-category`.

- [ ] **Step 3: Export `brandBlock` and write the module**

In `lib/athena/prompts.ts` change line 12 from `function brandBlock(` to `export function brandBlock(`.

Create `lib/athena/draft-category.ts`:

```ts
import { z } from "zod";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { brandBlock, type BrandContext } from "@/lib/athena/prompts";
import type { Category, PostType, RoleGuides } from "@/lib/types";

// Every conversation turn returns this whole object — there is no free-text
// assistant output outside it. assistant_message renders in the chat; the
// rest renders in the live-draft panel and is upserted onto the category row.
// Deliberately absent: style_ref_url, post_caption, buffer_channel_id,
// active, key — the model never drafts those.
export const DraftTurnOutput = z.object({
  assistant_message: z.string().describe(
    "Short conversational reply: what changed, then the single most important open question",
  ),
  name: z.string().describe("Short human-readable category name"),
  style_guide: z.string().describe(
    "Everything EVERY panel shares — palette, subject, typography, layout, any persistent footer. Direct instructions to an image model.",
  ),
  output_format: z.string().describe("How ideas in this category are structured, one or two lines"),
  post_type: z.enum(["independent", "narrative"]),
  role_guides: z.object({
    hook: z.string().describe("Treatment belonging to the opening panel only — empty string if none"),
    beat: z.string().describe("Treatment belonging to middle panels only — empty string if none"),
    payoff: z.string().describe("Treatment belonging to the final panel only — empty string if none"),
    single: z.string().describe("Treatment for standalone images — empty string if none"),
  }),
  images_per_carousel: z.number().int().min(1).max(10),
  aspect_ratio: z.string().describe('Like "4:5" or "9:16"'),
});

export interface NormalizedDraft {
  name: string;
  style_guide: string;
  output_format: string;
  post_type: PostType;
  role_guides: RoleGuides;
  images_per_carousel: number;
  aspect_ratio: string;
}

// The client-held conversation state. Assistant turns carry the draft their
// turn produced, so the model can be shown its own prior full drafts.
export interface DraftTurn {
  role: "user" | "assistant";
  text: string;
  imageUrls?: string[]; // Cloudinary URLs attached to a user turn
  draft?: NormalizedDraft;
}

export function normalizeDraft(
  d: Omit<z.infer<typeof DraftTurnOutput>, "assistant_message">,
): NormalizedDraft {
  const role_guides: RoleGuides = {};
  for (const role of ["hook", "beat", "payoff", "single"] as const) {
    const v = d.role_guides[role]?.trim();
    if (v) role_guides[role] = v;
  }
  return {
    name: d.name.trim() || "Untitled draft",
    style_guide: d.style_guide,
    output_format: d.output_format,
    post_type: d.post_type,
    role_guides,
    // The DB check constraint (migration 0009) rejects narrative with < 2
    // slides, and JSON Schema can't express the conditional — clamp here.
    images_per_carousel:
      d.post_type === "narrative" ? Math.max(2, d.images_per_carousel) : d.images_per_carousel,
    aspect_ratio: d.aspect_ratio.trim() || "4:5",
  };
}

export function categoryToDraft(
  c: Pick<
    Category,
    "name" | "style_guide" | "output_format" | "post_type" | "role_guides" |
    "images_per_carousel" | "aspect_ratio"
  >,
): NormalizedDraft {
  return {
    name: c.name,
    style_guide: c.style_guide,
    output_format: c.output_format,
    post_type: c.post_type,
    role_guides: c.role_guides ?? {},
    images_per_carousel: c.images_per_carousel,
    aspect_ratio: c.aspect_ratio,
  };
}

export function buildDraftSystemPrompt(brand: BrandContext, seed?: NormalizedDraft): string {
  const lines = [
    "You are helping the owner of this business define a POST TYPE (a \"category\"): a reusable recipe their content engine uses to write and illustrate social posts.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    "You are having a short conversation. EVERY reply must contain the complete draft — every field, self-consistent, reflecting the whole conversation so far — plus assistant_message, a short conversational reply.",
    "In assistant_message: say what you changed, then ask about the single most important thing still unclear. One question at a time. Never restate the draft fields in assistant_message — they are displayed beside the chat already.",
    "",
    "FIELD RULES:",
    "- style_guide holds what EVERY panel shares: palette, subject or character, typography, layout, any persistent footer. Write it as direct instructions to an image model.",
    "- post_type is 'independent' when each image stands completely alone, 'narrative' when the slides tell ONE story (hook, beats, payoff).",
    "- role_guides holds ONLY treatment that belongs to a single role — a tag or strike-through on the hook, say. Anything named here must NOT also appear in style_guide: a per-panel element left in the style guide lands on every panel, including panels it must not. Use an empty string when a role needs nothing special.",
    "- images_per_carousel: for narrative, the slide count of the story (2-10). For independent, how many standalone images one batch produces.",
    "- aspect_ratio: like \"4:5\" or \"9:16\".",
    "",
    "IF THE USER PROVIDES A SCREENSHOT OF A POST THEY LIKE:",
    "Extract ONLY structure and copy pattern from it: panel count, the job each panel does, pacing, how the text is worded.",
    "NEVER copy its colors, palette, fonts, photography style, or illustration style — this brand's visual identity comes from its own reference image, not from the example. Do not describe the screenshot's visual style in any field.",
  ];
  if (seed) {
    lines.push(
      "",
      "The user is revising an existing category. Its current fields:",
      JSON.stringify(seed, null, 2),
      "Change only what the conversation asks for; keep every other field verbatim.",
    );
  }
  return lines.join("\n");
}

export function toAnthropicMessages(turns: DraftTurn[]): MessageParam[] {
  return turns.map((t): MessageParam =>
    t.role === "assistant"
      ? { role: "assistant", content: JSON.stringify({ assistant_message: t.text, ...t.draft }) }
      : {
          role: "user",
          content: [
            ...(t.imageUrls ?? []).map((url) => ({
              type: "image" as const,
              source: { type: "url" as const, url },
            })),
            { type: "text" as const, text: t.text.trim() || "(no message — see attached image)" },
          ],
        },
  );
}
```

Note: if the installed `@anthropic-ai/sdk` version's `MessageParam` type path differs, find the correct import by checking how the SDK exports it (`node_modules/@anthropic-ai/sdk`), or fall back to `Anthropic.MessageParam` via `import type Anthropic from "@anthropic-ai/sdk"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/draft-category.test.ts tests/prompts.test.ts`
Expected: all PASS (prompts.test.ts confirms the `brandBlock` export change broke nothing).

- [ ] **Step 5: Commit**

```bash
git add lib/athena/draft-category.ts lib/athena/prompts.ts tests/draft-category.test.ts
git commit -m "feat: drafting schema, system prompt, and turn mappers for post-type authoring"
```

---

### Task 3: Conversation turn route (`POST /api/categories/draft`)

One endpoint per turn: takes the whole client-held conversation, calls Anthropic with structured output, normalizes, validates, and upserts the category row — create with `active: false` on the first turn, targeted update after. Returns the row id, the chat reply, and the normalized draft.

**Files:**
- Create: `app/api/categories/draft/route.ts`

**Interfaces:**
- Consumes: `DraftTurnOutput`, `buildDraftSystemPrompt`, `toAnthropicMessages`, `normalizeDraft`, `categoryToDraft`, `DraftTurn`, `NormalizedDraft` (Task 2); `validateCategoryFields`, `slugify`, `CategoryFields` (Task 1); `requireUser`, `requireAnthropicKey`, `createServerSupabase` (existing); `brandBlock` is used indirectly.
- Produces (Task 6's client calls this):
  - Request: `POST { turns: DraftTurn[], categoryId?: string, styleRefUrl?: string }` — `turns` non-empty, last turn `role: "user"`. `styleRefUrl` is sent only on a turn where the user newly uploaded a brand reference.
  - Response 200: `{ categoryId: string, assistantMessage: string, draft: NormalizedDraft }`
  - Errors: 401 `{error:"unauthorized"}`, 400 bad body, 404 unknown categoryId, 500 `{error: message}` (includes the BYOK "Add your Anthropic API key in Config" text — spec §7 requires passing that through verbatim).

- [ ] **Step 1: Write the route**

Mirror `app/api/ideas/generate/route.ts`'s structure (auth → body validation → work → error mapping). First check `node_modules/next/dist/docs/` for route-handler conventions in this Next version.

```ts
import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { validateCategoryFields, slugify, type CategoryFields } from "@/lib/categories";
import {
  DraftTurnOutput, buildDraftSystemPrompt, toAnthropicMessages,
  normalizeDraft, categoryToDraft, type DraftTurn, type NormalizedDraft,
} from "@/lib/athena/draft-category";
import type { BrandContext } from "@/lib/athena/prompts";
import type { Category } from "@/lib/types";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
// One draft object + a short chat reply — nowhere near the 16k idea batches.
const DRAFT_MAX_TOKENS = 4000;

// The columns a conversation turn is allowed to write on an existing row.
// Never: key, active, post_caption, buffer_channel_id — and style_ref_url
// only when the user uploaded a new reference this turn.
function draftColumns(draft: NormalizedDraft) {
  return {
    name: draft.name,
    style_guide: draft.style_guide,
    output_format: draft.output_format,
    post_type: draft.post_type,
    role_guides: draft.role_guides,
    images_per_carousel: draft.images_per_carousel,
    aspect_ratio: draft.aspect_ratio,
  };
}

function isDraftTurn(t: unknown): t is DraftTurn {
  if (!t || typeof t !== "object") return false;
  const turn = t as DraftTurn;
  return (
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.text === "string" &&
    (turn.imageUrls === undefined ||
      (Array.isArray(turn.imageUrls) && turn.imageUrls.every((u) => typeof u === "string")))
  );
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const turns = body?.turns;
  if (!Array.isArray(turns) || !turns.length || !turns.every(isDraftTurn) ||
      turns[turns.length - 1].role !== "user") {
    return NextResponse.json(
      { error: "expected { turns: DraftTurn[] } ending in a user turn" }, { status: 400 });
  }
  const categoryId = typeof body?.categoryId === "string" && body.categoryId ? body.categoryId : null;
  const styleRefUrl = typeof body?.styleRefUrl === "string" && body.styleRefUrl ? body.styleRefUrl : null;

  try {
    const supabase = await createServerSupabase();

    let existing: Category | null = null;
    if (categoryId) {
      const { data } = await supabase
        .from("categories").select("*").eq("id", categoryId).maybeSingle();
      if (!data) return NextResponse.json({ error: "unknown category" }, { status: 404 });
      existing = data as Category;
    }

    const { data: brandRow } = await supabase
      .from("brand_profiles").select("*").eq("user_id", user.id).maybeSingle();
    const brand: BrandContext = {
      business_name: brandRow?.business_name ?? "",
      business_description: brandRow?.business_description ?? "",
      audience: brandRow?.audience ?? "",
      voice: brandRow?.voice ?? "",
      avoid: brandRow?.avoid ?? "",
    };

    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id) });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: DRAFT_MAX_TOKENS,
      system: buildDraftSystemPrompt(brand, existing ? categoryToDraft(existing) : undefined),
      messages: toAnthropicMessages(turns as DraftTurn[]),
      output_config: { format: zodOutputFormat(DraftTurnOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error(`draft turn returned no parseable output (stop_reason: ${response.stop_reason})`);
    }
    const { assistant_message, ...rest } = parsed;
    const draft = normalizeDraft(rest);

    // Full-fields validation with defaults filled in — same validator the
    // manual actions use, so the wizard can never write a row the editor
    // couldn't have.
    const fields: CategoryFields = {
      ...draft,
      style_ref_url: styleRefUrl ?? existing?.style_ref_url ?? "",
      post_caption: existing?.post_caption ?? "",
      buffer_channel_id: existing?.buffer_channel_id ?? "",
      active: existing?.active ?? false,
    };
    validateCategoryFields(fields);

    let id: string;
    if (existing) {
      const patch = styleRefUrl
        ? { ...draftColumns(draft), style_ref_url: styleRefUrl }
        : draftColumns(draft);
      const { error } = await supabase.from("categories").update(patch).eq("id", existing.id);
      if (error) throw new Error(error.message);
      id = existing.id;
    } else {
      id = await insertDraft(supabase, user.id, draft, styleRefUrl ?? "");
    }

    return NextResponse.json({ categoryId: id, assistantMessage: assistant_message, draft });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("draft turn failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Same insert createCategory does, with active forced false and a bounded
// retry on key collision (23505) so the model picking an existing name on
// turn 1 doesn't dead-end the conversation. key is immutable after this.
async function insertDraft(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  userId: string,
  draft: NormalizedDraft,
  styleRefUrl: string,
): Promise<string> {
  const base = slugify(draft.name);
  for (const key of [base, `${base}_2`, `${base}_3`, `${base}_4`, `${base}_5`]) {
    const { data, error } = await supabase
      .from("categories")
      .insert({
        user_id: userId,
        key,
        ...draftColumns(draft),
        style_ref_url: styleRefUrl,
        post_caption: "",
        buffer_channel_id: "",
        active: false,
      })
      .select("id")
      .single();
    if (!error && data) return data.id as string;
    if (error && error.code !== "23505") throw new Error(error.message);
  }
  throw new Error("Could not find a free category name — ask for a different name and resend");
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: builds cleanly. (The route's behavior is exercised end-to-end in Task 6's manual verification; its pure pieces — mapping, normalization, validation — are already unit-tested in Tasks 1-2.)

- [ ] **Step 3: Commit**

```bash
git add app/api/categories/draft/route.ts
git commit -m "feat: conversation turn endpoint with continuous category upsert"
```

---

### Task 4: Preview logic (`lib/athena/preview.ts`)

Sample-idea generation (one non-persisting Anthropic call reusing the existing idea prompt builders) plus Kie submission built on the existing pure functions. The prompt assembly is extracted as a pure function and unit-tested; the effectful wrappers stay thin.

**Files:**
- Create: `lib/athena/preview.ts`
- Create: `tests/preview.test.ts`

**Interfaces:**
- Consumes: `buildIdeaSystemPrompt`, `buildIdeaUserPrompt`, `IdeasOutput`, `BrandContext` (`@/lib/athena/prompts`); `buildSlidePrompt` (`@/lib/athena/image-prompt`); `uploadStyleRef`, `createKieTask` (`@/lib/athena/kie`); `validateSlideShape` (`@/lib/athena/slides`); `requireAnthropicKey`, `requireKieKey`; `createAdminSupabase`.
- Produces (Task 5 imports these exact names):
  - `export function buildPreviewPrompts(category: Pick<Category, "style_guide" | "role_guides">, slides: Slide[]): { anchor: string; fanout: string[] }`
  - `export async function generateSamplePreviewIdea(userId: string, category: Category): Promise<{ concept: string; slides: Slide[] }>`
  - `export async function submitPreviewAnchor(userId: string, category: Category, slides: Slide[]): Promise<{ styleUrl: string; taskId: string }>`
  - `export async function submitPreviewFanout(userId: string, category: Category, slides: Slide[], styleUrl: string, anchorImageUrl: string): Promise<{ taskIds: string[] }>`

- [ ] **Step 1: Read `lib/athena/fanout.ts` and confirm the chained reference order**

The production fan-out passes `[styleUrl, anchorImageUrl]` (brand ref first, anchor second — the `TWO_REFERENCES` prompt text in `image-prompt.ts` depends on this order). Confirm by reading `lib/athena/fanout.ts` and mirror exactly. If it differs from `[styleUrl, anchorImageUrl]`, follow fanout.ts and fix this task's code to match.

- [ ] **Step 2: Write the failing test**

Create `tests/preview.test.ts` (pure function only — no mocks needed, matching the repo's test style):

```ts
import { describe, expect, it } from "vitest";
import { buildPreviewPrompts } from "@/lib/athena/preview";
import type { Slide } from "@/lib/types";

const slides: Slide[] = [
  { role: "hook", text: "MYTH: cramming works", visual: "wide shot, desk at night" },
  { role: "beat", text: "Your brain needs sleep", visual: "close-up, alarm clock" },
  { role: "payoff", text: "Spaced practice wins", visual: "tight crop, calm morning" },
];
const category = {
  style_guide: "Cream background, flat illustration.",
  role_guides: { hook: "Orange MYTH tag top-left" },
};

describe("buildPreviewPrompts", () => {
  it("builds an unchained anchor prompt from slide 0", () => {
    const { anchor } = buildPreviewPrompts(category, slides);
    expect(anchor).toContain("MYTH: cramming works");
    expect(anchor).toContain("Panel 1 of 3");
    expect(anchor).toContain("Reference the provided style image");
    expect(anchor).toContain("Orange MYTH tag top-left"); // hook role guide applied
  });
  it("builds chained prompts for every later slide", () => {
    const { fanout } = buildPreviewPrompts(category, slides);
    expect(fanout).toHaveLength(2);
    expect(fanout[0]).toContain("Panel 2 of 3");
    expect(fanout[0]).toContain("Two reference images");
    expect(fanout[1]).toContain("Panel 3 of 3");
  });
  it("handles a single-slide independent preview with no fanout", () => {
    const single: Slide[] = [{ role: "single", text: "One tip", visual: "flat lay" }];
    const { anchor, fanout } = buildPreviewPrompts(category, single);
    expect(anchor).toContain("One tip");
    expect(fanout).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/preview.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/preview`.

- [ ] **Step 4: Write the module**

```ts
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  buildIdeaSystemPrompt, buildIdeaUserPrompt, IdeasOutput, type BrandContext,
} from "@/lib/athena/prompts";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import { uploadStyleRef, createKieTask } from "@/lib/athena/kie";
import { validateSlideShape } from "@/lib/athena/slides";
import { requireAnthropicKey, requireKieKey } from "@/lib/settings/user-secrets";
import type { Category, Slide } from "@/lib/types";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const PREVIEW_IDEA_MAX_TOKENS = 4000; // one idea, max 10 slides

// Pure prompt assembly for a preview run: the same buildSlidePrompt calls
// production makes, minus every DB write. Anchor is unchained; slides 1..N
// are chained against [brand style ref, anchor image].
export function buildPreviewPrompts(
  category: Pick<Category, "style_guide" | "role_guides">,
  slides: Slide[],
): { anchor: string; fanout: string[] } {
  const total = slides.length;
  return {
    anchor: buildSlidePrompt(category.style_guide, slides[0], 1, total, false, "", category.role_guides),
    fanout: slides
      .slice(1)
      .map((s, i) => buildSlidePrompt(category.style_guide, s, i + 2, total, true, "", category.role_guides)),
  };
}

// One idea against this category, using the exact production prompt path —
// but never written to the ideas table. This is what "test this draft"
// generates against.
export async function generateSamplePreviewIdea(
  userId: string,
  category: Category,
): Promise<{ concept: string; slides: Slide[] }> {
  const supabase = createAdminSupabase();
  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").eq("user_id", userId).maybeSingle();
  const brand: BrandContext = {
    business_name: brandRow?.business_name ?? "",
    business_description: brandRow?.business_description ?? "",
    audience: brandRow?.audience ?? "",
    voice: brandRow?.voice ?? "",
    avoid: brandRow?.avoid ?? "",
  };

  const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(userId) });
  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: PREVIEW_IDEA_MAX_TOKENS,
    system: buildIdeaSystemPrompt(brand, [category]),
    messages: [{ role: "user", content: buildIdeaUserPrompt(1, [category.key]) }],
    output_config: { format: zodOutputFormat(IdeasOutput) },
  });
  const idea = response.parsed_output?.ideas?.[0];
  if (!idea) throw new Error("preview idea generation returned no usable idea");

  const expected = category.post_type === "narrative" ? category.images_per_carousel : 1;
  const slides = (idea.slides ?? []) as Slide[];
  const shape = validateSlideShape(slides, expected);
  if (!shape.ok) throw new Error(`preview idea had the wrong shape: ${shape.reason}`);
  return { concept: idea.concept, slides };
}

export async function submitPreviewAnchor(
  userId: string,
  category: Category,
  slides: Slide[],
): Promise<{ styleUrl: string; taskId: string }> {
  if (!category.style_ref_url) {
    throw new Error("Add a brand visual reference image first — the preview generates against it");
  }
  const kieKey = await requireKieKey(userId);
  const styleUrl = await uploadStyleRef(kieKey, category.style_ref_url, userId, category.key);
  const { anchor } = buildPreviewPrompts(category, slides);
  const taskId = await createKieTask(kieKey, anchor, [styleUrl], category.aspect_ratio);
  return { styleUrl, taskId };
}

export async function submitPreviewFanout(
  userId: string,
  category: Category,
  slides: Slide[],
  styleUrl: string,
  anchorImageUrl: string,
): Promise<{ taskIds: string[] }> {
  const kieKey = await requireKieKey(userId);
  const { fanout } = buildPreviewPrompts(category, slides);
  const taskIds: string[] = [];
  for (const prompt of fanout) {
    taskIds.push(await createKieTask(kieKey, prompt, [styleUrl, anchorImageUrl], category.aspect_ratio));
  }
  return { taskIds };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/preview.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/athena/preview.ts tests/preview.test.ts
git commit -m "feat: non-persisting preview generation for draft categories"
```

---

### Task 5: Preview route (`/api/categories/draft/preview`)

Stateless endpoints the wizard client orchestrates: POST starts a preview (`phase: "start"` → sample idea + anchor task) or fans out (`phase: "fanout"`), GET polls one task's status. Nothing is stored server-side between calls — the client carries `slides`/`styleUrl`/`anchorImageUrl` back in.

**Files:**
- Create: `app/api/categories/draft/preview/route.ts`

**Interfaces:**
- Consumes: `generateSamplePreviewIdea`, `submitPreviewAnchor`, `submitPreviewFanout` (Task 4); `getKieRecord` (`@/lib/athena/kie`); `requireUser`, `requireKieKey`, `createServerSupabase`.
- Produces (Task 7's client calls these):
  - `POST { categoryId, phase: "start" }` → 200 `{ concept: string, slides: Slide[], styleUrl: string, taskId: string }`
  - `POST { categoryId, phase: "fanout", slides: Slide[], styleUrl: string, anchorImageUrl: string }` → 200 `{ taskIds: string[] }`
  - `GET ?taskId=...` → 200 `{ state: string, resultUrl: string | null }` (raw `getKieRecord` result)
  - Errors: 401/400/404/500 `{error}` — same mapping style as Task 3.

- [ ] **Step 1: Read `lib/athena/poll-logic.ts` for the Kie state values**

Before writing the client in Task 7, the exact success/failure state strings must be known. Read `lib/athena/poll-logic.ts` (and `app/api/jobs/poll/route.ts` if needed) and note which `state` values mean done/failed/in-flight. Record them in a comment on the GET handler so Task 7's implementer sees them in this route's code.

- [ ] **Step 2: Write the route**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireKieKey } from "@/lib/settings/user-secrets";
import { getKieRecord } from "@/lib/athena/kie";
import {
  generateSamplePreviewIdea, submitPreviewAnchor, submitPreviewFanout,
} from "@/lib/athena/preview";
import type { Category, Slide } from "@/lib/types";

export const maxDuration = 120;

const ROLES = new Set(["hook", "beat", "payoff", "single"]);
function isSlideArray(v: unknown): v is Slide[] {
  return (
    Array.isArray(v) && v.length > 0 &&
    v.every(
      (s) => s && typeof s === "object" &&
        ROLES.has((s as Slide).role) &&
        typeof (s as Slide).text === "string" &&
        typeof (s as Slide).visual === "string",
    )
  );
}

async function loadCategory(categoryId: string): Promise<Category | null> {
  const supabase = await createServerSupabase(); // RLS scopes to the caller
  const { data } = await supabase
    .from("categories").select("*").eq("id", categoryId).maybeSingle();
  return (data as Category) ?? null;
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryId = body?.categoryId;
  const phase = body?.phase;
  if (typeof categoryId !== "string" || (phase !== "start" && phase !== "fanout")) {
    return NextResponse.json(
      { error: 'expected { categoryId: string, phase: "start" | "fanout" }' }, { status: 400 });
  }

  try {
    const category = await loadCategory(categoryId);
    if (!category) return NextResponse.json({ error: "unknown category" }, { status: 404 });

    if (phase === "start") {
      const { concept, slides } = await generateSamplePreviewIdea(user.id, category);
      const { styleUrl, taskId } = await submitPreviewAnchor(user.id, category, slides);
      return NextResponse.json({ concept, slides, styleUrl, taskId });
    }

    // phase === "fanout"
    if (!isSlideArray(body?.slides) || typeof body?.styleUrl !== "string" ||
        typeof body?.anchorImageUrl !== "string" || !body.anchorImageUrl) {
      return NextResponse.json(
        { error: "fanout expects { slides, styleUrl, anchorImageUrl }" }, { status: 400 });
    }
    const { taskIds } = await submitPreviewFanout(
      user.id, category, body.slides, body.styleUrl, body.anchorImageUrl);
    return NextResponse.json({ taskIds });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("preview failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Thin poll wrapper around getKieRecord — no DB row is involved anywhere in
// the preview path. State values (from lib/athena/poll-logic.ts):
// <RECORD THE ACTUAL VALUES HERE IN STEP 1 — e.g. "success" / "fail" / else in-flight>
export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const taskId = request.nextUrl.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });
  try {
    const kieKey = await requireKieKey(user.id);
    const record = await getKieRecord(kieKey, taskId);
    return NextResponse.json(record);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

Replace the placeholder comment line on the GET handler with the actual state values found in Step 1.

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: builds cleanly.

- [ ] **Step 4: Commit**

```bash
git add app/api/categories/draft/preview/route.ts
git commit -m "feat: stateless preview endpoints for draft categories"
```

---

### Task 6: Wizard page and client — start screen, chat, live draft panel

The `/config/draft` page (fresh or `?category=<id>` for revise) and the client component: input slots on the start screen, the chat loop with optimistic-turn rollback on failure, the live draft panel, and the exit to `/config`. The preview pane is Task 7 — this task leaves a clearly-marked mount point.

**Files:**
- Create: `app/(app)/config/draft/page.tsx`
- Create: `app/(app)/config/draft/draft-wizard.tsx`

**Interfaces:**
- Consumes: `POST /api/categories/draft` (Task 3's request/response shapes); `uploadStyleRefImage` from `../actions` (existing — takes `FormData` with field `"file"`, returns `{url?, error?}`); `getKeyStatus` from `@/lib/settings/user-secrets`; type-only imports `DraftTurn`, `NormalizedDraft`, `categoryToDraft` from `@/lib/athena/draft-category` (safe — that module has no `server-only` import; keep value imports to `categoryToDraft` only, which is pure).
- Produces: `DraftWizard` client component with props `{ initialCategory: Category | null; keys: { anthropic: boolean; kie: boolean } }`. Task 7 adds the preview pane inside it.

- [ ] **Step 1: Read `app/(app)/config/page.tsx` and mirror its conventions**

Before writing the page: how does it authenticate, how does it fetch, and (per the Next.js constraint) how do pages in this repo receive `searchParams`? Mirror exactly.

- [ ] **Step 2: Write the server page**

`app/(app)/config/draft/page.tsx` — adjust auth/searchParams handling to whatever Step 1 found:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getKeyStatus } from "@/lib/settings/user-secrets";
import { DraftWizard } from "./draft-wizard";
import type { Category } from "@/lib/types";

export default async function DraftPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const user = await requireUser();
  const { category: categoryId } = await searchParams;

  let category: Category | null = null;
  if (categoryId) {
    const supabase = await createServerSupabase();
    const { data } = await supabase
      .from("categories").select("*").eq("id", categoryId).maybeSingle();
    category = (data as Category) ?? null;
  }
  const keys = await getKeyStatus(user.id);
  return <DraftWizard initialCategory={category} keys={keys} />;
}
```

- [ ] **Step 3: Write the client wizard**

`app/(app)/config/draft/draft-wizard.tsx`. Follow the repo's existing client-component idioms (`category-manager.tsx` is the style reference: shadcn `Button`/`Input`/`Textarea`/`Label`/`Card`, `useState`, plain `fetch`).

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uploadStyleRefImage } from "../actions";
import { categoryToDraft, type DraftTurn, type NormalizedDraft } from "@/lib/athena/draft-category";
import type { Category } from "@/lib/types";

interface Props {
  initialCategory: Category | null;
  keys: { anthropic: boolean; kie: boolean };
}

export function DraftWizard({ initialCategory, keys }: Props) {
  const router = useRouter();
  const [turns, setTurns] = useState<DraftTurn[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(initialCategory?.id ?? null);

  // Start-screen input slots
  const [description, setDescription] = useState("");
  const [formatUrl, setFormatUrl] = useState("");        // "show it" screenshot
  const [brandRefUrl, setBrandRefUrl] = useState(initialCategory?.style_ref_url ?? "");
  // A brand ref uploaded but not yet sent with a turn
  const [pendingStyleRef, setPendingStyleRef] = useState<string | null>(null);
  const [uploading, setUploading] = useState<"format" | "brand" | null>(null);

  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const lastDraft: NormalizedDraft | null =
    [...turns].reverse().find((t) => t.role === "assistant")?.draft ??
    (initialCategory ? categoryToDraft(initialCategory) : null);

  async function upload(kind: "format" | "brand", file: File) {
    setUploading(kind);
    setError("");
    const fd = new FormData();
    fd.append("file", file);
    const res = await uploadStyleRefImage(fd);
    setUploading(null);
    if (res.error || !res.url) { setError(`Upload failed: ${res.error ?? "no url"}`); return; }
    if (kind === "format") setFormatUrl(res.url);
    else { setBrandRefUrl(res.url); setPendingStyleRef(res.url); }
  }

  async function send(text: string, imageUrls?: string[]) {
    const userTurn: DraftTurn = { role: "user", text, imageUrls };
    const nextTurns = [...turns, userTurn];
    setTurns(nextTurns);
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/categories/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turns: nextTurns,
          categoryId: categoryId ?? undefined,
          styleRefUrl: pendingStyleRef ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCategoryId(json.categoryId);
      setPendingStyleRef(null);
      setTurns([...nextTurns, { role: "assistant", text: json.assistantMessage, draft: json.draft }]);
    } catch (e) {
      // Spec §7: a failed turn leaves conversation state untouched so the
      // user can just resend — roll back the optimistic user turn and
      // restore the composer.
      setTurns(turns);
      setComposer(text);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  function start() {
    if (!description.trim() && !formatUrl) return;
    void send(description.trim(), formatUrl ? [formatUrl] : undefined);
  }

  if (!keys.anthropic) {
    return (
      <Card>
        <CardContent className="py-6 text-sm">
          Add your Anthropic API key in <Link className="underline" href="/config">Config</Link> to
          draft with AI.
        </CardContent>
      </Card>
    );
  }

  const started = turns.length > 0;

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {initialCategory ? `Revise "${initialCategory.name}" with AI` : "Draft a post type with AI"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!started && (
              <div className="space-y-3">
                <div>
                  <Label>Describe it</Label>
                  <Textarea
                    rows={4}
                    placeholder="e.g. Myth-busting carousels: open with a common SAT myth, debunk it over two panels, end with the real insight."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Or show it — screenshot of a post whose format you like (optional)</Label>
                  <p className="text-xs text-muted-foreground">
                    Only its structure and copy pattern are used — never its colors or art style.
                  </p>
                  <input type="file" accept="image/*" className="block text-sm"
                    onChange={(e) => e.target.files?.[0] && upload("format", e.target.files[0])} />
                  {uploading === "format" && <p className="text-xs text-muted-foreground">Uploading…</p>}
                  {formatUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={formatUrl} alt="format example" className="mt-2 h-32 rounded border object-cover" />
                  )}
                </div>
                <div>
                  <Label>Brand visual reference (optional)</Label>
                  <p className="text-xs text-muted-foreground">
                    {brandRefUrl
                      ? "This image controls the visual look of everything generated."
                      : "No reference set — previews and generation will look generic until one is added."}
                  </p>
                  <input type="file" accept="image/*" className="block text-sm"
                    onChange={(e) => e.target.files?.[0] && upload("brand", e.target.files[0])} />
                  {uploading === "brand" && <p className="text-xs text-muted-foreground">Uploading…</p>}
                  {brandRefUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={brandRefUrl} alt="brand reference" className="mt-2 h-32 rounded border object-cover" />
                  )}
                </div>
                <Button onClick={start} disabled={sending || (!description.trim() && !formatUrl)}>
                  {sending ? "Drafting…" : "Start drafting"}
                </Button>
              </div>
            )}

            {started && (
              <div className="space-y-3">
                <div className="max-h-[50vh] space-y-3 overflow-y-auto">
                  {turns.map((t, i) => (
                    <div key={i}
                      className={t.role === "user" ? "ml-8 rounded-lg bg-muted p-3 text-sm" : "mr-8 rounded-lg border p-3 text-sm"}>
                      {t.imageUrls?.map((u) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={u} src={u} alt="" className="mb-2 h-24 rounded border object-cover" />
                      ))}
                      <p className="whitespace-pre-wrap">{t.text}</p>
                    </div>
                  ))}
                  {sending && <p className="text-sm text-muted-foreground">Thinking…</p>}
                </div>
                <div className="flex gap-2">
                  <Textarea rows={2} value={composer} placeholder="Refine the draft…"
                    onChange={(e) => setComposer(e.target.value)} />
                  <Button
                    disabled={sending || !composer.trim()}
                    onClick={() => { const text = composer; setComposer(""); void send(text); }}>
                    Send
                  </Button>
                </div>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>

        {/* TASK 7 MOUNT POINT: preview pane renders here once a categoryId exists */}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Live draft</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!lastDraft && <p className="text-muted-foreground">The draft appears here as you talk.</p>}
            {lastDraft && (
              <>
                <DraftField label="Name" value={lastDraft.name} />
                <DraftField label="Post type"
                  value={lastDraft.post_type === "narrative"
                    ? `Narrative — ${lastDraft.images_per_carousel} slides, one story`
                    : "Independent — each image stands alone"} />
                <DraftField label="Style guide" value={lastDraft.style_guide} />
                <DraftField label="Output format" value={lastDraft.output_format} />
                {Object.entries(lastDraft.role_guides).map(([role, guide]) => (
                  <DraftField key={role} label={`Treatment: ${role}`} value={guide ?? ""} />
                ))}
                <DraftField label="Aspect ratio" value={lastDraft.aspect_ratio} />
              </>
            )}
            {categoryId && (
              <div className="pt-2">
                <p className="mb-2 text-xs text-muted-foreground">
                  Saved automatically as an inactive category after every reply.
                </p>
                <Button variant="outline" size="sm" onClick={() => router.push("/config")}>
                  Open in editor
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DraftField({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap">{value}</p>
    </div>
  );
}
```

- [ ] **Step 4: Verify build and smoke-test the page**

Run: `npm run build` — expected: clean.
Run: `npm run dev`, open `http://localhost:3000/config/draft` — expected: start screen renders with the three input slots (or the add-API-key card if this dev environment has no key configured — both are correct renders). Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config/draft/page.tsx" "app/(app)/config/draft/draft-wizard.tsx"
git commit -m "feat: AI drafting wizard - start screen, chat, live draft panel"
```

---

### Task 7: Preview pane — anchor test, full-carousel test, polling

Adds the test-run UI at Task 6's mount point: "Test this draft" submits a sample idea + anchor image, polling until done; for narrative drafts an explicit "Generate full test carousel" fans out the remaining slides chained to the anchor. Client-orchestrated; failures show inline with Retry and never block exiting (spec §6).

**Files:**
- Create: `app/(app)/config/draft/preview-pane.tsx`
- Modify: `app/(app)/config/draft/draft-wizard.tsx` (replace the Task 7 mount-point comment with the component)

**Interfaces:**
- Consumes: Task 5's endpoints; `Slide`, `NormalizedDraft` types.
- Produces: `PreviewPane` with props `{ categoryId: string; postType: "independent" | "narrative"; hasStyleRef: boolean; hasKieKey: boolean }`.

- [ ] **Step 1: Write the component**

Use the Kie state values recorded in the Task 5 GET-handler comment — the strings below (`"success"` / `"fail"`) are placeholders to be confirmed against that comment.

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Slide } from "@/lib/types";

interface Props {
  categoryId: string;
  postType: "independent" | "narrative";
  hasStyleRef: boolean;
  hasKieKey: boolean;
}

interface TaskState { taskId: string; url?: string; status: "pending" | "done" | "failed"; error?: string }

interface PreviewRun {
  concept: string;
  slides: Slide[];
  styleUrl: string;
  anchor: TaskState;
  fanout: TaskState[] | null;
}

// Confirm these against the state values documented on the preview route's
// GET handler (Task 5 Step 1) before merging.
const DONE_STATE = "success";
const FAILED_STATE = "fail";

async function pollTask(taskId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`/api/categories/draft/preview?taskId=${encodeURIComponent(taskId)}`);
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
    if (json.state === DONE_STATE && json.resultUrl) return { ok: true, url: json.resultUrl };
    if (json.state === FAILED_STATE) return { ok: false, error: "image generation failed" };
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, error: "timed out after 5 minutes" };
}

export function PreviewPane({ categoryId, postType, hasStyleRef, hasKieKey }: Props) {
  const [run, setRun] = useState<PreviewRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function startTest() {
    setBusy(true);
    setError("");
    setRun(null);
    try {
      const res = await fetch("/api/categories/draft/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId, phase: "start" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const initial: PreviewRun = {
        concept: json.concept, slides: json.slides, styleUrl: json.styleUrl,
        anchor: { taskId: json.taskId, status: "pending" }, fanout: null,
      };
      setRun(initial);
      const done = await pollTask(json.taskId);
      setRun((p) => p && {
        ...p,
        anchor: { ...p.anchor, status: done.ok ? "done" : "failed", url: done.url, error: done.error },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function fullTest() {
    if (!run?.anchor.url) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/categories/draft/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId, phase: "fanout",
          slides: run.slides, styleUrl: run.styleUrl, anchorImageUrl: run.anchor.url,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const taskIds: string[] = json.taskIds;
      setRun((p) => p && { ...p, fanout: taskIds.map((taskId) => ({ taskId, status: "pending" as const })) });
      await Promise.all(
        taskIds.map(async (taskId, i) => {
          const done = await pollTask(taskId);
          setRun((p) => {
            if (!p?.fanout) return p;
            const fanout = [...p.fanout];
            fanout[i] = { taskId, status: done.ok ? "done" : "failed", url: done.url, error: done.error };
            return { ...p, fanout };
          });
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Test run</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Generates one real sample post against this draft. Nothing is saved to your ideas or gallery.
        </p>
        {!hasKieKey && <p className="text-muted-foreground">Add your Kie.ai API key in Config to run tests.</p>}
        {hasKieKey && !hasStyleRef && (
          <p className="text-muted-foreground">Add a brand visual reference above to run a test.</p>
        )}
        {hasKieKey && hasStyleRef && (
          <div className="flex gap-2">
            <Button size="sm" onClick={startTest} disabled={busy}>
              {busy && !run ? "Generating…" : run ? "Retry test" : "Test this draft"}
            </Button>
            {postType === "narrative" && run?.anchor.status === "done" && !run.fanout && (
              <Button size="sm" variant="outline" onClick={fullTest} disabled={busy}>
                Generate full test carousel
              </Button>
            )}
          </div>
        )}
        {run && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Sample idea: {run.concept}</p>
            <div className="flex flex-wrap gap-2">
              <PreviewImage state={run.anchor} label={run.slides[0]?.role ?? "anchor"} />
              {run.fanout?.map((t, i) => (
                <PreviewImage key={t.taskId} state={t} label={run.slides[i + 1]?.role ?? `slide ${i + 2}`} />
              ))}
            </div>
          </div>
        )}
        {error && <p className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function PreviewImage({ state, label }: { state: TaskState; label: string }) {
  return (
    <div className="w-32">
      {state.status === "pending" && (
        <div className="flex h-40 w-32 items-center justify-center rounded border text-xs text-muted-foreground">
          generating…
        </div>
      )}
      {state.status === "failed" && (
        <div className="flex h-40 w-32 items-center justify-center rounded border border-destructive p-2 text-center text-xs text-destructive">
          {state.error ?? "failed"}
        </div>
      )}
      {state.status === "done" && state.url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.url} alt={label} className="h-40 w-32 rounded border object-cover" />
      )}
      <p className="mt-1 text-center text-xs capitalize text-muted-foreground">{label}</p>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the wizard**

In `draft-wizard.tsx`, add the import and replace the mount-point comment:

```tsx
import { PreviewPane } from "./preview-pane";
```

```tsx
{categoryId && lastDraft && (
  <PreviewPane
    categoryId={categoryId}
    postType={lastDraft.post_type}
    hasStyleRef={!!brandRefUrl}
    hasKieKey={keys.kie}
  />
)}
```

- [ ] **Step 3: Verify build**

Run: `npm run build` — expected: clean.
Run: `npx vitest run` — expected: all tests still pass.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/config/draft/preview-pane.tsx" "app/(app)/config/draft/draft-wizard.tsx"
git commit -m "feat: test-run preview pane with anchor and full-carousel generation"
```

---

### Task 8: Entry points, docs pointer, final sweep

Wire the wizard into `/config` ("Draft with AI" for new, "Revise with AI" per category), note the shipped spec in the followups doc, and run the full verification battery.

**Files:**
- Modify: `app/(app)/config/category-manager.tsx`
- Modify: `docs/superpowers/plans/2026-07-27-structured-carousels-followups.md` (§5)

**Interfaces:**
- Consumes: the `/config/draft` page (Task 6). No new exports.

- [ ] **Step 1: Add the entry buttons**

In `app/(app)/config/category-manager.tsx`:

Add `import Link from "next/link";` at the top.

In `CategoryEditor`, next to the Delete button (inside the `category && (...)` block becomes a fragment holding both):

```tsx
{category && (
  <>
    <Button asChild variant="outline" size="sm">
      <Link href={`/config/draft?category=${category.id}`}>Revise with AI</Link>
    </Button>
    <Button variant="destructive" size="sm" disabled={pending} onClick={remove}>Delete</Button>
  </>
)}
```

In `CategoryManager`, next to the "Add a new category" heading:

```tsx
<div>
  <div className="mb-2 flex items-center justify-between">
    <p className="text-sm font-medium">Add a new category</p>
    <Button asChild variant="outline" size="sm">
      <Link href="/config/draft">✨ Draft with AI</Link>
    </Button>
  </div>
  <CategoryEditor channels={channels} />
</div>
```

- [ ] **Step 2: Update the followups doc**

In `docs/superpowers/plans/2026-07-27-structured-carousels-followups.md` §5, append one line at the end of the section:

```markdown
**Update 2026-07-27:** spec written and implemented — see
`docs/superpowers/specs/2026-07-27-ai-assisted-post-type-authoring-design.md`
and `docs/superpowers/plans/2026-07-27-ai-assisted-post-type-authoring.md`.
```

- [ ] **Step 3: Full verification battery**

Run: `npx vitest run` — expected: all pass.
Run: `npx eslint .` — expected: ONLY the pre-existing `post-composer.tsx:34` error (Global Constraints); no new findings.
Run: `npm run build` — expected: clean.
Run: `npm run dev`, open `/config` — expected: "✨ Draft with AI" appears by the add form, "Revise with AI" on each existing category, both navigate to the wizard. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/config/category-manager.tsx" docs/superpowers/plans/2026-07-27-structured-carousels-followups.md
git commit -m "feat: wire AI drafting wizard into config, note shipped spec in followups"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §3 conversation mechanics → Tasks 2-3; §4 continuous upsert + revise → Task 3; §5 entry points/input slots → Tasks 6, 8; §6 preview → Tasks 4-5, 7; §7 error handling → Tasks 3, 5, 6, 7 (BYOK message passthrough, turn rollback, preview retry); §8 testing → Tasks 1, 2, 4.
- **The model never drafts `style_ref_url`/`post_caption`/`buffer_channel_id`/`active`/`key`** — enforced by the schema shape (Task 2) and the `draftColumns` allowlist (Task 3).
- **Two known verify-at-execution points, deliberately marked in-plan:** the Kie state strings (Task 5 Step 1 → Task 7's `DONE_STATE`/`FAILED_STATE`), and the chained-reference order (Task 4 Step 1 vs `fanout.ts`).
- **End-to-end LLM/image behavior is not machine-verifiable in CI** (BYOK keys, paid calls). After Task 8, the human should run one real drafting conversation and one test preview against a real key before flipping any drafted category active.
