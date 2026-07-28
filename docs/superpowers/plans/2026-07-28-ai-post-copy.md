# AI-Written Post Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-post LLM-written copy for LinkedIn/X-style posting — a `caption_guide` mode on categories, `post_text` written in the existing idea call, platform presets from the Buffer channel service, composer prefill plus rewrite-with-notes against the generated images, and the wizard drafting the guide.

**Architecture:** The mode is the guide's presence: non-empty `categories.caption_guide` → the idea-generation call also emits `post_text` per idea (platform preset from `buffer_channel_service` → brand voice → guide override, most-specific-wins); empty → today's rotating `post_caption` byte-untouched. Copy shows on idea cards, prefills the composer when the selection is one idea, and a stateless BYOK endpoint rewrites it with the selected images as vision input.

**Tech Stack:** Next.js App Router (nonstandard version — see constraints), `@anthropic-ai/sdk` + `zodOutputFormat`, Supabase RLS, vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-ai-post-copy-design.md`

## Global Constraints

- **Static mode must be byte-untouched:** a category with empty `caption_guide` generates, filters, displays, and posts exactly as today — no prompt-section, no schema pressure toward copy, `pickCaption` rotation unchanged.
- **BYOK:** the rewrite endpoint uses `requireAnthropicKey(user.id)`; never env keys.
- **Rewrite persists nothing** — it returns text into composer state; Buffer receives whatever the user posts, as today (spec §5).
- **Model id** `process.env.CLAUDE_MODEL || "claude-sonnet-5"`; `IDEA_GENERATION_MAX_TOKENS` stays 16000 (SDK non-streaming ceiling — see the comment atop `lib/athena/generate-ideas.ts`; never raise it).
- **The wizard's LLM never drafts URL/identity fields** — `caption_guide` joins its schema (it is a guide), `buffer_channel_service`/`buffer_channel_id`/`post_caption`/`style_ref_url`/`active`/`key` stay out.
- **Platform preset matching is case-insensitive and covers both `twitter` and `x`** as the X service string — Buffer's exact value is unverified, so match both.
- **This is NOT the Next.js you know** (AGENTS.md): mirror existing files' conventions (`app/api/categories/draft/route.ts` for routes) and check `node_modules/next/dist/docs/` when unsure.
- `npx eslint .` pre-existing failures: `app/(app)/post/post-composer.tsx:34` (error) and a warning in `scripts/import-athena-legacy.ts`. No NEW findings allowed. Tests: `npx vitest run` (167 passing at plan time).
- No tables beyond migration 0011's three columns.

---

### Task 1: Migration 0011, types, editor fields

**Files:**
- Create: `supabase/migrations/0011_post_copy.sql`
- Modify: `lib/types.ts` (Category, Idea)
- Modify: `lib/categories.ts` (CategoryFields)
- Modify: `app/(app)/config/actions.ts` (create/update column writes)
- Modify: `app/(app)/config/category-manager.tsx` (caption_guide textarea, channel-service capture)
- Test: `tests/categories.test.ts` (extend)

**Interfaces:**
- Consumes: existing `CategoryFields`, `validateCategoryFields` (no new validation rules — both new fields are plain strings).
- Produces: `Category.caption_guide: string`, `Category.buffer_channel_service: string`, `Idea.post_text: string`, and `CategoryFields` carrying `caption_guide` + `buffer_channel_service`. Every later task relies on these exact names.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0011_post_copy.sql
-- AI-written post copy (spec 2026-07-28-ai-post-copy-design.md).
-- The mode is the guide's presence: non-empty caption_guide means the idea
-- call also writes post_text for this category; empty means the rotating
-- post_caption variants keep working untouched.
alter table categories add column caption_guide text not null default '';

-- The Buffer channel's service ("linkedin", "twitter", "instagram", ...),
-- captured client-side when the channel is picked in Config — generation
-- derives the platform preset from it without a live Buffer call. Empty
-- (pre-existing rows until their next save) falls back to a generic preset.
alter table categories add column buffer_channel_service text not null default '';

-- The copy draft written at idea time; edited (not persisted) at post time.
alter table ideas add column post_text text not null default '';
```

Do NOT apply it anywhere — file only, applied to Supabase at deploy time.

- [ ] **Step 2: Write the failing test**

Append to `tests/categories.test.ts` (the `base` fixture is at the top of the file):

```ts
describe("CategoryFields copy fields", () => {
  it("accepts caption_guide and buffer_channel_service as plain strings", () => {
    expect(() =>
      validateCategoryFields({
        ...base,
        caption_guide: "Long-form thought leadership.",
        buffer_channel_service: "linkedin",
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/categories.test.ts`
Expected: FAIL — TypeScript/object-literal error because `CategoryFields` lacks the fields.

- [ ] **Step 4: Implement**

`lib/types.ts` — in `Category`, after `role_guides`:
```ts
  caption_guide: string;
  buffer_channel_service: string;
```
In `Idea`, after `slides`:
```ts
  post_text: string;
```

`lib/categories.ts` — in `CategoryFields`, after `post_caption`:
```ts
  caption_guide: string;
  buffer_channel_service: string;
```
(No new `validateCategoryFields` rules — strings, same as `post_caption`.)

`app/(app)/config/actions.ts` — add to BOTH the `createCategory` insert object and the `updateCategory` update object:
```ts
    caption_guide: fields.caption_guide,
    buffer_channel_service: fields.buffer_channel_service,
```

`app/(app)/config/category-manager.tsx`:
- `EMPTY` gains `caption_guide: "", buffer_channel_service: "",` and the `category ? {...}` initializer gains `caption_guide: category.caption_guide, buffer_channel_service: category.buffer_channel_service ?? "",`.
- The Buffer channel `<select>`'s `onChange` captures the service alongside the id (the `channels` array items carry `service`):
```tsx
onChange={(e) => {
  const id = e.target.value;
  const service = channels.find((c) => c.id === id)?.service ?? "";
  setForm((f) => ({ ...f, buffer_channel_id: id, buffer_channel_service: service }));
}}
```
- New field directly ABOVE the "Post caption" field:
```tsx
<div><Label>Copy guide (AI-written post text)</Label>
  <p className="text-xs text-muted-foreground">
    Filled in: the AI writes each post&apos;s copy in this voice, shaped for the
    platform of the Buffer channel below. Empty: the rotating captions below
    are used, exactly as before.
  </p>
  <Textarea rows={4} value={form.caption_guide}
    onChange={(e) => set("caption_guide", e.target.value)} /></div>
```

- [ ] **Step 5: Run tests, typecheck**

Run: `npx vitest run` — all pass (Task 4's wizard route also constructs `CategoryFields`; if `npx tsc --noEmit` flags `app/api/categories/draft/route.ts` for the two missing fields, add them there now with existing-row fallbacks, matching its `post_caption` pattern: `caption_guide: existing?.caption_guide ?? "", buffer_channel_service: existing?.buffer_channel_service ?? "",`).
Run: `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0011_post_copy.sql lib/types.ts lib/categories.ts "app/(app)/config/actions.ts" "app/(app)/config/category-manager.tsx" "app/api/categories/draft/route.ts" tests/categories.test.ts
git commit -m "feat: caption_guide mode, channel service capture, post_text columns"
```

---

### Task 2: Copy prompt section, ideas schema, generation storage

**Files:**
- Modify: `lib/athena/prompts.ts` (platform presets, copy section, `IdeasOutput`)
- Modify: `lib/athena/generate-ideas.ts` (store `post_text`, include it in the filter payload)
- Test: `tests/prompts.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `Category.caption_guide` / `buffer_channel_service`.
- Produces: `buildIdeaSystemPrompt`'s `categories` parameter type gains `caption_guide: string; buffer_channel_service: string;` (callers pass full `Category` objects — structurally satisfied); `IdeasOutput` ideas gain `post_text: z.string()`; exported `platformPresetFor(service: string): string` for Task 5's rewrite endpoint.

- [ ] **Step 1: Write the failing tests**

Append to `tests/prompts.test.ts` (extend the file's existing `cats` literals with `caption_guide: "", buffer_channel_service: ""` wherever TypeScript now requires the fields — mechanical):

```ts
describe("buildIdeaSystemPrompt — post copy", () => {
  const copyCat = {
    key: "TL", style_guide: "G", output_format: "", images_per_carousel: 5,
    post_type: "narrative" as const,
    caption_guide: "First person, contrarian, end with a question.",
    buffer_channel_service: "linkedin",
  };
  const staticCat = {
    key: "MEME", style_guide: "G2", output_format: "", images_per_carousel: 1,
    post_type: "independent" as const, caption_guide: "", buffer_channel_service: "instagram",
  };

  it("adds a copy section only for categories with a caption_guide", () => {
    const p = buildIdeaSystemPrompt(brand, [copyCat, staticCat]);
    expect(p).toContain("POST COPY for TL");
    expect(p).not.toContain("POST COPY for MEME");
  });

  it("tells static categories to leave post_text empty", () => {
    const p = buildIdeaSystemPrompt(brand, [copyCat, staticCat]);
    expect(p).toContain('post_text must be the empty string ""');
  });

  it("stacks preset, then guide as the override", () => {
    const p = buildIdeaSystemPrompt(brand, [copyCat]);
    const preset = p.indexOf("thought leadership");
    const guide = p.indexOf("First person, contrarian, end with a question.");
    expect(preset).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(preset);
    expect(p).toContain("guide wins");
  });

  it("emits no copy instructions at all when no category has a guide", () => {
    const p = buildIdeaSystemPrompt(brand, [staticCat]);
    expect(p).not.toContain("POST COPY");
  });
});

describe("platformPresetFor", () => {
  it("maps linkedin, twitter/x, instagram, and unknown", () => {
    expect(platformPresetFor("linkedin")).toContain("thought leadership");
    expect(platformPresetFor("twitter")).toContain("280");
    expect(platformPresetFor("x")).toContain("280");
    expect(platformPresetFor("Instagram")).toContain("hashtags");
    expect(platformPresetFor("")).toContain("caption");
  });
});
```

Add `platformPresetFor` to the file's imports from `@/lib/athena/prompts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL — `platformPresetFor` not exported; copy-section assertions unmet.

- [ ] **Step 3: Implement in `lib/athena/prompts.ts`**

Extend the `buildIdeaSystemPrompt` categories parameter type with `caption_guide: string; buffer_channel_service: string;`. Add:

```ts
// Platform conventions, most general layer of the copy stack. Case-
// insensitive; Buffer's exact service string for X is unverified, so both
// "twitter" and "x" match. Unknown/empty service gets a generic preset.
export function platformPresetFor(service: string): string {
  switch (service.trim().toLowerCase()) {
    case "linkedin":
      return "LinkedIn long-form thought leadership: a scroll-stopping hook line first, short paragraphs with line breaks, a concrete takeaway, no hashtag spam (2-3 max, at the end, if any). Roughly 600-1300 characters.";
    case "twitter":
    case "x":
      return "X post: tight and punchy, under 280 characters, no hashtags unless the guide asks.";
    case "instagram":
      return "Instagram caption: one to three short lines, then a blank line, then relevant hashtags.";
    default:
      return "A short platform-neutral caption: one or two sentences that frame the post.";
  }
}
```

In `buildIdeaSystemPrompt`, after the existing per-category guides block, append a copy block ONLY when at least one category has a non-empty `caption_guide`:

```ts
  const copyCats = categories.filter((c) => c.caption_guide.trim());
  const copyBlock = copyCats.length
    ? [
        "",
        "POST COPY (the 'post_text' field):",
        "Some categories below carry copy instructions. For THOSE categories only, also write post_text: the full text published alongside the images — it is the primary asset on text-first platforms, the images support it. Write it from the same conception as the slides, but never duplicate the slide text verbatim.",
        `For every other category, post_text must be the empty string "".`,
        "Layering, most general to most specific — where they conflict, the category's guide wins:",
        ...copyCats.map((c) =>
          [
            `POST COPY for ${c.key}:`,
            `Platform: ${platformPresetFor(c.buffer_channel_service)}`,
            `Guide: ${c.caption_guide}`,
          ].join("\n"),
        ),
      ]
    : [];
```

Join `copyBlock` into the returned prompt (before the "CRITICAL INSTRUCTION FOR concept" block). When `copyCats` is empty the prompt is byte-identical to before except for the parameter type — assert nothing changed by keeping all existing tests green.

`IdeasOutput`: add to the idea object shape:
```ts
      post_text: z.string().describe(
        "full post copy for categories with copy instructions; the empty string for all others",
      ),
```

- [ ] **Step 4: Wire storage in `lib/athena/generate-ideas.ts`**

- In the `raw` mapping, carry `post_text` through, gated so a static category can never store stray copy: build a `copyModeKeys = new Set(cats.filter(c => c.caption_guide.trim()).map(c => c.key))` and map `post_text: copyModeKeys.has(i.category) ? (i.post_text ?? "") : ""`.
- The filter call's payload is `JSON.stringify(raw, ...)` — `post_text` now rides along automatically; no other change.
- The `kept.map` insert object gains `post_text: i.post_text,` (requires `post_text` on the mapped intermediate — thread it through `applyFilterDecisions`' input/output the same way `slides` is threaded; check `lib/athena/filter.ts` and extend its type by the one field if it enumerates them).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run` — all green (including the mechanical fixture extensions).
Run: `npx tsc --noEmit` — clean (this also proves `generateSamplePreviewIdea` in preview.ts still satisfies the widened parameter via full `Category`).

- [ ] **Step 6: Commit**

```bash
git add lib/athena/prompts.ts lib/athena/generate-ideas.ts lib/athena/filter.ts tests/prompts.test.ts
git commit -m "feat: idea call writes platform-shaped post copy for caption_guide categories"
```

---

### Task 3: Idea cards show copy; manual ideas can carry it

**Files:**
- Modify: `app/(app)/ideas/idea-card.tsx` (collapsible copy preview)
- Modify: `app/(app)/ideas/manual-idea-dialog.tsx` (optional post-text field)
- Modify: `app/(app)/ideas/actions.ts` (`createManualIdea` accepts optional `postText`)

**Interfaces:**
- Consumes: `Idea.post_text` (Task 1).
- Produces: `createManualIdea(input: { categoryKey: string; concept: string; slides: Slide[]; postText?: string })`.

- [ ] **Step 1: Idea card**

In `idea-card.tsx`, below the existing expandable slides area (reuse the card's existing `expanded` state and styling idioms), render when `idea.post_text` is non-empty:

```tsx
{idea.post_text.trim() && (
  <div className="mt-2 rounded-md border bg-muted/40 p-2">
    <button
      type="button"
      className="text-xs font-medium text-muted-foreground"
      onClick={() => setCopyOpen((v) => !v)}
    >
      {copyOpen ? "Hide post copy" : "Show post copy"}
    </button>
    {copyOpen && <p className="mt-1 whitespace-pre-wrap text-sm">{idea.post_text}</p>}
  </div>
)}
```
with `const [copyOpen, setCopyOpen] = useState(false);` added beside the existing state. Adapt placement to the card's actual JSX so it renders for every status (the copy is part of the post no matter the stage).

- [ ] **Step 2: Manual dialog + action**

`app/(app)/ideas/actions.ts` — extend `createManualIdea`'s input type with `postText?: string` and the insert object with `post_text: input.postText?.trim() ?? ""`.

`manual-idea-dialog.tsx` — add `const [postText, setPostText] = useState("");`, a field after the slides block:

```tsx
<div>
  <Label>Post copy (optional)</Label>
  <p className="text-xs text-muted-foreground">
    The text published with the post — used on text-first platforms like LinkedIn.
  </p>
  <Textarea rows={4} value={postText} onChange={(e) => setPostText(e.target.value)} />
</div>
```

and pass `postText` in the `createManualIdea` call.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — clean. Run: `npx vitest run` — all green. Run: `npm run build` — clean.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/ideas/idea-card.tsx" "app/(app)/ideas/manual-idea-dialog.tsx" "app/(app)/ideas/actions.ts"
git commit -m "feat: show post copy on idea cards, accept it on manual ideas"
```

---

### Task 4: Wizard drafts the copy guide

**Files:**
- Modify: `lib/athena/draft-category.ts` (`DraftTurnOutput`, `NormalizedDraft`, `normalizeDraft`, `categoryToDraft`, prompt field rules)
- Modify: `app/api/categories/draft/route.ts` (`draftColumns` allowlist)
- Modify: `app/(app)/config/draft/draft-wizard.tsx` (live-draft panel row)
- Test: `tests/draft-category.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `Category.caption_guide`.
- Produces: `NormalizedDraft.caption_guide: string`; the draft route writes it on create and update.

- [ ] **Step 1: Write the failing tests**

Append to `tests/draft-category.test.ts` (add `caption_guide: "Punchy first person."` to the file's `rawDraft` fixture, which will also exercise parse/normalize round-trips):

```ts
describe("caption_guide in the draft", () => {
  it("passes through normalizeDraft", () => {
    expect(normalizeDraft(rawDraft).caption_guide).toBe("Punchy first person.");
  });
  it("maps from a category row, defaulting missing to empty", () => {
    const d = categoryToDraft({
      name: "N", style_guide: "S", output_format: "O", post_type: "independent",
      role_guides: {}, images_per_carousel: 3, aspect_ratio: "4:5",
      caption_guide: undefined as never,
    });
    expect(d.caption_guide).toBe("");
  });
  it("appears in the system prompt's field rules", () => {
    expect(buildDraftSystemPrompt(brand)).toContain("caption_guide");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/draft-category.test.ts`
Expected: FAIL — schema/type lacks the field.

- [ ] **Step 3: Implement**

`lib/athena/draft-category.ts`:
- `DraftTurnOutput` gains, after `role_guides`:
```ts
  caption_guide: z.string().describe(
    "Copy instructions for the platform this category posts to — voice, structure, length, hashtags. Empty string if the category should keep static rotating captions instead of AI-written copy.",
  ),
```
- `NormalizedDraft` gains `caption_guide: string;`. `normalizeDraft` passes it through trimmed-preserving (`caption_guide: d.caption_guide` — do NOT trim away internal formatting; empty stays empty). `categoryToDraft`'s `Pick` gains `"caption_guide"` and maps `caption_guide: c.caption_guide ?? ""`.
- `buildDraftSystemPrompt` FIELD RULES gains one line:
```
"- caption_guide: how the post's published TEXT is written (voice, structure, length) for the platform it posts to. Leave it an empty string when static rotating captions are the right fit — e.g. simple image-first posts.",
```

`app/api/categories/draft/route.ts` — `draftColumns` returns `caption_guide: draft.caption_guide,` too. (Task 1 already gave the route's full-`CategoryFields` construction the `caption_guide`/`buffer_channel_service` fallbacks; the update allowlist gaining `caption_guide` is this task. `buffer_channel_service` stays OUT of `draftColumns` — the wizard never touches channels.)

`app/(app)/config/draft/draft-wizard.tsx` — live-draft panel gains, after the role-guide rows:
```tsx
<DraftField label="Copy guide" value={lastDraft.caption_guide} />
```
(`DraftField` already hides empty values.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run` — all green. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/draft-category.ts "app/api/categories/draft/route.ts" "app/(app)/config/draft/draft-wizard.tsx" tests/draft-category.test.ts
git commit -m "feat: wizard drafts the copy guide"
```

---

### Task 5: Composer prefill, rewrite endpoint, rewrite UI, final battery

**Files:**
- Modify: `lib/athena/carousel.ts` (add `resolveInitialCaption`, extend `Postable`)
- Modify: `app/(app)/post/page.tsx` (carry `post_text` into postables)
- Modify: `app/(app)/post/post-composer.tsx` (prefill, "Use idea copy", "Rewrite with notes")
- Create: `app/api/posts/rewrite-caption/route.ts`
- Test: `tests/carousel.test.ts` (extend — the file exists; check its name with `ls tests/` and extend whichever file tests `pickCaption`/`selectAutoFill`; create `tests/carousel.test.ts` if none does)

**Interfaces:**
- Consumes: `Idea.post_text`, `platformPresetFor` (Task 2), `requireAnthropicKey`, `brandBlock`/`BrandContext` (`lib/athena/prompts.ts`), route conventions from `app/api/categories/draft/route.ts`.
- Produces: `POST /api/posts/rewrite-caption` `{ categoryKey, ideaId?, note, imageUrls, currentText }` → `{ text }`; `resolveInitialCaption(selected: Postable[], category: Pick<Category, "post_caption">): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveInitialCaption, type Postable } from "@/lib/athena/carousel";

const p = (idea_id: string, post_text: string): Postable => ({
  generation_id: `g-${Math.random()}`, idea_id, idea_created_at: "2026-07-28",
  public_url: "https://x/y.png", concept: "c", slide_index: 0, slide_count: 1,
  post_text,
});

describe("resolveInitialCaption", () => {
  const category = { post_caption: "one||two" };
  it("uses the idea's copy when every selected image is that idea and it has copy", () => {
    expect(resolveInitialCaption([p("a", "the copy"), p("a", "the copy")], category)).toBe("the copy");
  });
  it("falls back to rotation for mixed ideas", () => {
    const out = resolveInitialCaption([p("a", "the copy"), p("b", "other")], category);
    expect(["one", "two"]).toContain(out);
  });
  it("falls back to rotation when the idea has no copy", () => {
    const out = resolveInitialCaption([p("a", "")], category);
    expect(["one", "two"]).toContain(out);
  });
  it("falls back to rotation for an empty selection", () => {
    const out = resolveInitialCaption([], category);
    expect(["one", "two"]).toContain(out);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/carousel.test.ts`
Expected: FAIL — `resolveInitialCaption` not exported / `Postable` lacks `post_text`.

- [ ] **Step 3: Implement the pure pieces**

`lib/athena/carousel.ts`:
- `Postable` gains `post_text: string;`.
- Add:
```ts
// Spec §5 prefill rule: the caption box starts from the idea's AI-written
// copy only when the whole selection IS that one idea; anything mixed or
// copy-less keeps today's rotating variants.
export function resolveInitialCaption(
  selected: Postable[],
  category: Pick<Category, "post_caption">,
  rand: () => number = Math.random,
): string {
  const ideaIds = new Set(selected.map((s) => s.idea_id));
  if (ideaIds.size === 1) {
    const text = selected[0].post_text.trim();
    if (text) return text;
  }
  return pickCaption(category.post_caption, rand);
}
```
(Import `Category` type; check `pickCaption`'s existing signature — it already takes an optional `rand`.)

`app/(app)/post/page.tsx` — the ideas query's select must include `post_text`, and the postable construction gains `post_text: idea.post_text ?? "",`. Read the file; the query at line ~18 selects from `ideas` — add the column to its select list if columns are enumerated, otherwise `select("*")` already covers it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/carousel.test.ts` — PASS.

- [ ] **Step 5: The rewrite endpoint**

`app/api/posts/rewrite-caption/route.ts` — mirror `app/api/categories/draft/route.ts`'s conventions (auth → body validation → RLS loads → LLM → error mapping):

```ts
import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { brandBlock, platformPresetFor, type BrandContext } from "@/lib/athena/prompts";
import type { Category, Idea } from "@/lib/types";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const RewriteOutput = z.object({ text: z.string().describe("the rewritten post copy, nothing else") });

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryKey = body?.categoryKey;
  const note = body?.note;
  const currentText = typeof body?.currentText === "string" ? body.currentText : "";
  const ideaId = typeof body?.ideaId === "string" && body.ideaId ? body.ideaId : null;
  const imageUrls: string[] = Array.isArray(body?.imageUrls)
    ? body.imageUrls.filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://")).slice(0, 10)
    : [];
  if (typeof categoryKey !== "string" || typeof note !== "string" || !note.trim()) {
    return NextResponse.json(
      { error: "expected { categoryKey: string, note: string, imageUrls?: string[], ideaId?: string, currentText?: string }" },
      { status: 400 });
  }

  try {
    const supabase = await createServerSupabase();
    const { data: catData } = await supabase
      .from("categories").select("*").eq("key", categoryKey).maybeSingle();
    if (!catData) return NextResponse.json({ error: "unknown category" }, { status: 404 });
    const category = catData as Category;

    let idea: Idea | null = null;
    if (ideaId) {
      const { data } = await supabase.from("ideas").select("*").eq("id", ideaId).maybeSingle();
      idea = (data as Idea) ?? null;
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

    const system = [
      "You rewrite the published text of one social post. Return only the rewritten copy.",
      "",
      "BRAND CONTEXT:",
      brandBlock(brand),
      "",
      `PLATFORM: ${platformPresetFor(category.buffer_channel_service)}`,
      category.caption_guide.trim() ? `COPY GUIDE (wins over the platform note where they conflict):\n${category.caption_guide}` : "",
      idea?.slides?.length
        ? `THE POST'S SLIDES (for context — do not repeat their text verbatim):\n${JSON.stringify(idea.slides)}`
        : "",
      "The attached images are the post's actual visuals — the copy may reference what they show.",
    ].filter(Boolean).join("\n");

    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id) });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages: [{
        role: "user",
        content: [
          ...imageUrls.map((url) => ({ type: "image" as const, source: { type: "url" as const, url } })),
          {
            type: "text" as const,
            text: `CURRENT COPY:\n${currentText || "(none yet)"}\n\nREWRITE INSTRUCTION:\n${note}`,
          },
        ],
      }],
      output_config: { format: zodOutputFormat(RewriteOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) throw new Error(`rewrite returned no parseable output (stop_reason: ${response.stop_reason})`);
    return NextResponse.json({ text: parsed.text });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("caption rewrite failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

Note: the categories/ideas loads rely on RLS scoping exactly like the draft routes (verified convention). Nothing here writes to any table.

- [ ] **Step 6: Composer wiring**

`app/(app)/post/post-composer.tsx`:
- Caption init becomes `useState(() => resolveInitialCaption(initial, category))` (import from carousel; drop the direct `pickCaption` import if now unused).
- Below the caption `Textarea`, add the two affordances:

```tsx
const sameIdea = selected.length > 0 && new Set(selected.map((s) => s.idea_id)).size === 1;
const ideaCopy = sameIdea ? selected[0].post_text.trim() : "";
const [rewriteNote, setRewriteNote] = useState("");
const [rewriting, setRewriting] = useState(false);
const [rewriteError, setRewriteError] = useState("");

async function rewrite() {
  setRewriting(true);
  setRewriteError("");
  try {
    const res = await fetch("/api/posts/rewrite-caption", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        categoryKey: category.key,
        ideaId: sameIdea ? selected[0].idea_id : undefined,
        note: rewriteNote,
        imageUrls: selected.map((s) => s.public_url),
        currentText: caption,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    setCaption(json.text);
    setRewriteNote("");
  } catch (e) {
    setRewriteError(e instanceof Error ? e.message : String(e));
  } finally {
    setRewriting(false);
  }
}
```

```tsx
{ideaCopy && caption !== ideaCopy && (
  <Button variant="outline" size="sm" onClick={() => setCaption(ideaCopy)}>
    Use this idea&apos;s copy
  </Button>
)}
<div className="flex gap-2">
  <Textarea rows={1} placeholder="Rewrite the copy… (e.g. shorter, punchier hook)"
    value={rewriteNote} onChange={(e) => setRewriteNote(e.target.value)} />
  <Button variant="outline" size="sm" disabled={rewriting || !rewriteNote.trim()} onClick={rewrite}>
    {rewriting ? "Rewriting…" : "Rewrite with notes"}
  </Button>
</div>
{rewriteError && <p className="text-sm text-destructive">{rewriteError}</p>}
```

Place them directly under the existing caption textarea, following the file's layout idioms. IMPORTANT: this file carries the pre-existing lint error at line 34 — do not fix or move it; keep edits away from that hunk if possible.

- [ ] **Step 7: Full battery**

Run: `npx vitest run` — all green. `npx tsc --noEmit` — clean. `npm run build` — clean. `npx eslint .` — only the two pre-existing findings.

- [ ] **Step 8: Commit**

```bash
git add lib/athena/carousel.ts "app/(app)/post/page.tsx" "app/(app)/post/post-composer.tsx" app/api/posts/rewrite-caption/route.ts tests/carousel.test.ts
git commit -m "feat: composer prefills idea copy and rewrites it against the images"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §2 → Task 1; §3 → Task 2 (+manual path in Task 3); §4 → Task 3; §5 → Task 5; §6 → Task 4; §7 error handling → Tasks 2 (shape-drop already exists) and 5 (endpoint mapping, inline composer error); §8 testing → Tasks 1, 2, 4, 5. §9's out-of-scope list has no tasks, correctly.
- **Type consistency:** `caption_guide`/`buffer_channel_service`/`post_text` names match across all five tasks; `platformPresetFor` defined in Task 2, consumed in Task 5; `resolveInitialCaption` defined and consumed in Task 5.
- **Execution-time verifications deliberately delegated:** whether `tests/carousel.test.ts` already exists (Task 5 Step 1), whether `/post/page.tsx` enumerates columns (Task 5 Step 3), whether `lib/athena/filter.ts` enumerates idea fields (Task 2 Step 4), and Buffer's real `service` strings (covered by matching both `twitter` and `x`, case-insensitive).
- **End-to-end LLM behavior is not CI-verifiable** (BYOK): after Task 5, the human runs one copy-mode idea batch and one rewrite against real keys. Migration 0011 must be applied to Supabase before any of it works in prod.
