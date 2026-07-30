# Auto-Generated Style Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Test Run dead-end for any category missing a brand reference image — generate one automatically from the brand's own scraped colors/fonts/visual_notes, persist it, and let the user regenerate it with notes at any time. Also fix an unrelated, previously-diagnosed bug where the preview path's single-shot idea generation has no tolerance for an occasional malformed slide shape.

**Architecture:** A new Kie text-to-image call plus a pure, brand-grounded prompt builder feed a new two-phase API route (`generate` → poll → `finalize`) that re-hosts the result on Cloudinary and writes it straight to `categories.style_ref_url`. A small shared client module holds both the existing Kie-task polling logic (extracted, unchanged) and the new generate/poll/finalize orchestration, reused identically by the wizard's Test Run flow and by Config's category editor's new "Regenerate" control.

**Tech Stack:** Next.js (App Router, server actions, route handlers), Supabase (Postgres via `createServerSupabase`), Kie.ai's task-based image API, Cloudinary, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-auto-style-ref-design.md`

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing Next.js code.** This is not the Next.js in your training data — APIs, conventions, and file structure differ. See `AGENTS.md`.
- **The placeholder prompt must always forbid a logo, wordmark, invented product photography, and text overlays**, in every branch (design-tokens present or absent). This is not a style preference — a prior Kie test (2026-07-27, on record) demonstrated the generative route reliably fails at inventing a believable mark.
- **A category missing design tokens (empty `colors`/`fonts`/`visual_notes`) must still generate a placeholder**, falling back to `business_description`/`voice`/`audience`. Never block generation on a thin brand profile.
- **The generated image is always persisted directly to `categories.style_ref_url`** — both Test Run's automatic first-time generation and the explicit "Regenerate" control write immediately, with no deferred-save step. (Decided during planning: the spec left this open; making both callers share one behavior removes an inconsistency with no offsetting benefit.)
- **Regenerate has no confirmation dialog**, working on any current reference regardless of how it got there (generated or manually uploaded) — matches how a manual upload already overwrites with no confirmation.
- **The placeholder image's aspect ratio is always the category's own `aspect_ratio`** — the same value every other Kie call for that category already uses.
- **No live-LLM or live-Kie tests.** Test pure functions directly. Run the suite with `npm test`.
- **BYOK:** Kie calls resolve the key with `requireKieKey(user.id)`; Anthropic calls (unrelated Task 5 only) resolve with `requireAnthropicKey(user.id)`.
- **`export const maxDuration = 120`** on the new route.

---

### Task 1: Kie text-to-image call and the brand-grounded prompt builder

**Files:**
- Modify: `lib/athena/kie.ts`
- Create: `lib/athena/style-ref-prompt.ts`
- Test: `tests/style-ref-prompt.test.ts`

**Interfaces:**
- Consumes: `BrandContext` from `@/lib/athena/prompts` (existing).
- Produces: `createTextToImageKieTask(apiKey: string, prompt: string, aspectRatio: string): Promise<string>` in `lib/athena/kie.ts`; `buildStyleRefPrompt(brand: BrandContext, notes?: string): string` in `lib/athena/style-ref-prompt.ts`.

**Context you need:** `lib/athena/kie.ts` already has `createKieTask`, which calls Kie's `createTask` endpoint with `model: "gpt-image-2-image-to-image"` and an `input_urls` array (image-to-image, seeded from a reference). This task's new function is the same shape but pure text-to-image — no seed image, no `input_urls`, model string `"gpt-image-2-text-to-image"`. Read the existing `createKieTask` and `kieHeaders` in that file before writing — match the error-message format and response-parsing exactly.

- [ ] **Step 1: Write the failing prompt-builder tests**

Create `tests/style-ref-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildStyleRefPrompt } from "@/lib/athena/style-ref-prompt";
import type { BrandContext } from "@/lib/athena/prompts";

function brand(over: Partial<BrandContext> = {}): BrandContext {
  return {
    business_name: "Athena",
    business_description: "An SAT prep platform that teaches like a personal tutor.",
    audience: "Parents of high-schoolers",
    voice: "Warm, encouraging, plain-spoken",
    avoid: "",
    proof_points: [],
    standing: [],
    colors: [],
    fonts: [],
    visual_notes: "",
    ...over,
  };
}

describe("buildStyleRefPrompt", () => {
  it("cites the real palette when colors are known", () => {
    const out = buildStyleRefPrompt(brand({ colors: ["#112233", "#445566"] }));
    expect(out).toContain("#112233");
    expect(out).toContain("#445566");
  });

  it("cites the real type when fonts are known", () => {
    expect(buildStyleRefPrompt(brand({ fonts: ["Poppins"] }))).toContain("Poppins");
  });

  it("cites visual notes when present", () => {
    expect(buildStyleRefPrompt(brand({ visual_notes: "Rounded corners, playful icons" })))
      .toContain("Rounded corners, playful icons");
  });

  it("falls back to business fields when no design tokens exist", () => {
    const out = buildStyleRefPrompt(brand());
    expect(out).toContain("An SAT prep platform");
    expect(out).toContain("Warm, encouraging, plain-spoken");
    expect(out).toContain("Parents of high-schoolers");
  });

  it("does not mention a palette line when no colors are known", () => {
    expect(buildStyleRefPrompt(brand())).not.toContain("Palette:");
  });

  it("always forbids logos and invented products, with or without design tokens", () => {
    expect(buildStyleRefPrompt(brand())).toContain("NO logo");
    expect(buildStyleRefPrompt(brand({ colors: ["#ffffff"] }))).toContain("NO logo");
  });

  it("appends regeneration notes when given, omits the line when not", () => {
    expect(buildStyleRefPrompt(brand(), "more muted, less saturated"))
      .toContain("more muted, less saturated");
    expect(buildStyleRefPrompt(brand())).not.toContain("Additional direction");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/style-ref-prompt.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/style-ref-prompt`.

- [ ] **Step 3: Implement `buildStyleRefPrompt`**

Create `lib/athena/style-ref-prompt.ts`:

```ts
import type { BrandContext } from "@/lib/athena/prompts";

// A placeholder brand style reference, generated with no seed image. This is
// pure text-to-image, so it must never attempt a logo or a specific product —
// a prior Kie test (2026-07-27) showed the generative route reliably fails at
// inventing a believable mark. Restricting every branch to an abstract
// color/texture/mood board keeps every generated placeholder honest about
// what it actually is.
export function buildStyleRefPrompt(brand: BrandContext, notes?: string): string {
  const hasDesignTokens =
    brand.colors.length > 0 || brand.fonts.length > 0 || brand.visual_notes.trim().length > 0;

  const lines: string[] = [
    "Generate an abstract brand style reference image: a flat background/texture study, not a photograph of any specific object, product, or logo.",
  ];

  if (hasDesignTokens) {
    lines.push("Base it on this brand's actual visual identity:");
    if (brand.colors.length) lines.push(`- Palette: ${brand.colors.join(", ")}`);
    if (brand.fonts.length) lines.push(`- Typographic feel: ${brand.fonts.join(", ")}`);
    if (brand.visual_notes.trim()) lines.push(`- Visual notes: ${brand.visual_notes.trim()}`);
  } else {
    lines.push(
      "No specific palette or type is known yet, so base the mood on the business itself:",
      `- What it is: ${brand.business_description || "a small business"}`,
      `- Voice: ${brand.voice || "plain and approachable"}`,
      `- Audience: ${brand.audience || "a general audience"}`,
    );
  }

  lines.push(
    "",
    "Absolute constraints: NO logo, NO wordmark, NO invented product photography, NO text overlays. This is a placeholder style board only — an abstract color-and-texture composition, nothing else.",
  );

  if (notes?.trim()) {
    lines.push("", `Additional direction for this regeneration: ${notes.trim()}`);
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/style-ref-prompt.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the Kie text-to-image function**

In `lib/athena/kie.ts`, add after the existing `createKieTask` function:

```ts
// Pure text-to-image — no seed image, no input_urls. Used to generate a
// placeholder brand style reference when a category has none yet.
export async function createTextToImageKieTask(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
): Promise<string> {
  const res = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST",
    headers: kieHeaders(apiKey),
    body: JSON.stringify({
      model: "gpt-image-2-text-to-image",
      input: { prompt, aspect_ratio: aspectRatio },
    }),
  });
  const json = await res.json().catch(() => null);
  const taskId = json?.data?.taskId;
  if (!res.ok || !taskId) {
    throw new Error(
      `Kie text-to-image createTask failed (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return taskId as string;
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/kie.ts lib/athena/style-ref-prompt.ts tests/style-ref-prompt.test.ts
git commit -m "feat: Kie text-to-image call and brand-grounded style-ref prompt"
```

---

### Task 2: `POST /api/categories/draft/style-ref`

**Files:**
- Create: `app/api/categories/draft/style-ref/route.ts`

**Interfaces:**
- Consumes: `createTextToImageKieTask` (Task 1); `buildStyleRefPrompt` (Task 1); `BrandContext` from `@/lib/athena/prompts`; `Category` from `@/lib/types`; `uploadImageToCloudinary` from `@/lib/cloudinary`; `requireUser`, `requireKieKey`, `createServerSupabase`, `friendlyLlmError`.
- Produces: `POST /api/categories/draft/style-ref` — `{categoryId, phase: "generate", notes?: string}` → `{taskId: string}`; `{categoryId, phase: "finalize", imageUrl: string}` → `{styleRefUrl: string}` (also writes `categories.style_ref_url` as a side effect).

**Context you need:** This route always writes on `finalize` — there is no deferred-save variant (see Global Constraints). Model this on `app/api/categories/draft/promote-refs/route.ts` for the fetch/validate/re-host pattern (HTTPS-only, 15MB cap, content-type check) — read that file's `fetchAndUpload` helper before writing this task's validation, and match its exact error-message style. The `generate` phase needs no Anthropic call at all — the prompt is built deterministically from the brand row, no LLM involved.

- [ ] **Step 1: Write the route**

Create `app/api/categories/draft/style-ref/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireKieKey } from "@/lib/settings/user-secrets";
import { createTextToImageKieTask } from "@/lib/athena/kie";
import { buildStyleRefPrompt } from "@/lib/athena/style-ref-prompt";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import type { BrandContext } from "@/lib/athena/prompts";
import type { Category } from "@/lib/types";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryId = typeof body?.categoryId === "string" && body.categoryId ? body.categoryId : null;
  const phase = body?.phase;
  if (!categoryId || (phase !== "generate" && phase !== "finalize")) {
    return NextResponse.json(
      { error: 'expected { categoryId: string, phase: "generate" | "finalize" }' }, { status: 400 });
  }

  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.from("categories").select("*").eq("id", categoryId).maybeSingle();
    if (!data) return NextResponse.json({ error: "unknown category" }, { status: 404 });
    const category = data as Category;

    if (phase === "generate") {
      const notes = typeof body?.notes === "string" ? body.notes : undefined;
      const { data: brandRow } = await supabase
        .from("brand_profiles").select("*").eq("user_id", user.id).maybeSingle();
      const brand: BrandContext = {
        business_name: brandRow?.business_name ?? "",
        business_description: brandRow?.business_description ?? "",
        audience: brandRow?.audience ?? "",
        voice: brandRow?.voice ?? "",
        avoid: brandRow?.avoid ?? "",
        proof_points: brandRow?.proof_points ?? [],
        standing: brandRow?.standing ?? [],
        colors: brandRow?.colors ?? [],
        fonts: brandRow?.fonts ?? [],
        visual_notes: brandRow?.visual_notes ?? "",
      };
      const kieKey = await requireKieKey(user.id);
      const prompt = buildStyleRefPrompt(brand, notes);
      const taskId = await createTextToImageKieTask(kieKey, prompt, category.aspect_ratio);
      return NextResponse.json({ taskId });
    }

    // phase === "finalize"
    const imageUrl = body?.imageUrl;
    if (typeof imageUrl !== "string" || !imageUrl) {
      return NextResponse.json({ error: "finalize expects { imageUrl: string }" }, { status: 400 });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      return NextResponse.json({ error: "imageUrl is not a valid URL" }, { status: 400 });
    }
    if (parsedUrl.protocol !== "https:") {
      return NextResponse.json({ error: "imageUrl must be https" }, { status: 400 });
    }

    const fetched = await fetch(imageUrl);
    if (!fetched.ok) throw new Error(`fetching generated image failed with HTTP ${fetched.status}`);
    const contentType = (fetched.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      throw new Error(`expected an image response, got ${contentType || "unknown content-type"}`);
    }
    const contentLength = fetched.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      throw new Error("generated image exceeds 15MB limit");
    }
    const buffer = Buffer.from(await fetched.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) throw new Error("generated image exceeds 15MB limit");

    const { url: styleRefUrl } = await uploadImageToCloudinary(buffer, contentType);

    const { error } = await supabase
      .from("categories").update({ style_ref_url: styleRefUrl }).eq("id", categoryId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ styleRefUrl });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("style-ref generation failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all existing tests still pass (this task adds no test file — it calls live Kie/Cloudinary services, consistent with every other Kie-calling route in this repo having no test file).

- [ ] **Step 4: Commit**

```bash
git add app/api/categories/draft/style-ref/route.ts
git commit -m "feat: POST /api/categories/draft/style-ref (generate + finalize)"
```

---

### Task 3: Shared client helper, and wire the automatic Test Run flow

**Files:**
- Create: `lib/style-ref-client.ts`
- Modify: `app/(app)/config/draft/preview-pane.tsx`
- Modify: `app/(app)/config/draft/draft-wizard.tsx`

**Interfaces:**
- Consumes: `POST /api/categories/draft/style-ref` (Task 2); the existing `GET /api/categories/draft/preview?taskId=...` (unchanged, already task-agnostic).
- Produces: `pollTask(taskId: string): Promise<{ ok: boolean; url?: string; error?: string }>` and `generateStyleRef(categoryId: string, notes?: string): Promise<string>`, both in `lib/style-ref-client.ts`. `PreviewPane`'s new prop shape: `{ categoryId: string; postType: "independent" | "narrative"; styleRefUrl: string; hasKieKey: boolean; onStyleRefGenerated: (url: string) => void }` — replacing the old `hasStyleRef: boolean` prop entirely.

**Context you need:** `preview-pane.tsx` currently defines its own local `pollTask` function (with `DONE_STATE`/`FAILED_STATE`/`MAX_CONSECUTIVE_POLL_ERRORS`) used by both `startTest()` and `fullTest()`. This task moves that function verbatim into a new shared module (no behavior change) so `generateStyleRef` can reuse it, since generating a placeholder involves the exact same poll-until-done logic against the exact same GET endpoint.

Read `app/(app)/config/draft/preview-pane.tsx` and `app/(app)/config/draft/draft-wizard.tsx` in full before editing — the diffs below are precise but you need the surrounding file to place them correctly. This repo's `AGENTS.md` says to read `node_modules/next/dist/docs/` before writing Next.js code — you're editing existing, already-working client components using patterns already present in both files, so this is lower risk than greenfield work, but skim the docs if anything looks unfamiliar.

- [ ] **Step 1: Create the shared client module**

Create `lib/style-ref-client.ts`:

```ts
// Confirmed against the state values documented on the preview route's GET
// handler (app/api/categories/draft/preview/route.ts): "success" -> done,
// "fail" -> failed, anything else -> still in flight.
const DONE_STATE = "success";
const FAILED_STATE = "fail";

// Kie polling is documented as intermittently flaky, and production
// tolerates this via cron re-polls. A single bad poll (network blip,
// malformed body, one non-ok response) must not permanently fail a task
// when the underlying job may still succeed seconds later. Only give up
// after this many CONSECUTIVE poll errors.
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

export interface PollResult {
  ok: boolean;
  url?: string;
  error?: string;
}

// Polls a Kie task via the existing (task-agnostic) preview GET endpoint
// until it succeeds, fails, or times out. Shared by the test-run flow and
// by style-ref generation — both are "create a Kie task, wait for it"
// operations against the exact same polling contract.
export async function pollTask(taskId: string): Promise<PollResult> {
  let consecutiveErrors = 0;
  let lastError: string | undefined;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`/api/categories/draft/preview?taskId=${encodeURIComponent(taskId)}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || json == null) {
        lastError = json?.error ?? `HTTP ${res.status}`;
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) return { ok: false, error: lastError };
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      consecutiveErrors = 0;
      if (json.state === DONE_STATE) {
        if (json.resultUrl) return { ok: true, url: json.resultUrl };
        return { ok: false, error: "generation reported success but returned no image" };
      }
      if (json.state === FAILED_STATE) return { ok: false, error: "image generation failed" };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) return { ok: false, error: lastError };
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, error: "timed out after 5 minutes" };
}

// Runs the full generate -> poll -> finalize sequence for a brand-grounded
// placeholder style reference image. Always persists the result as the
// category's real style_ref_url (see the plan's Global Constraints) — every
// caller of this function gets an immediately-persisted write, so Test Run's
// automatic first-time generation and an explicit "Regenerate" share one
// path rather than diverging on when the write happens.
export async function generateStyleRef(categoryId: string, notes?: string): Promise<string> {
  const genRes = await fetch("/api/categories/draft/style-ref", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categoryId, phase: "generate", notes }),
  });
  const genJson = await genRes.json();
  if (!genRes.ok) throw new Error(genJson.error ?? `HTTP ${genRes.status}`);

  const done = await pollTask(genJson.taskId);
  if (!done.ok || !done.url) throw new Error(done.error ?? "style reference generation failed");

  const finalRes = await fetch("/api/categories/draft/style-ref", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categoryId, phase: "finalize", imageUrl: done.url }),
  });
  const finalJson = await finalRes.json();
  if (!finalRes.ok) throw new Error(finalJson.error ?? `HTTP ${finalRes.status}`);
  return finalJson.styleRefUrl as string;
}
```

- [ ] **Step 2: Update `preview-pane.tsx` — imports and props**

In `app/(app)/config/draft/preview-pane.tsx`:

Remove the local `pollTask` function and its `DONE_STATE`/`FAILED_STATE`/`MAX_CONSECUTIVE_POLL_ERRORS` constants entirely (they now live in `lib/style-ref-client.ts`). Keep the local `TaskState` interface — it's UI-specific (anchor/fanout slot state) and unrelated to `pollTask`'s own return shape.

Add these imports — `Textarea` is new (the file currently imports `Button` and the `Card` family only, from `@/components/ui/button` and `@/components/ui/card`, but not `Textarea`, which the new Regenerate control in Step 4 needs):

```tsx
import { Textarea } from "@/components/ui/textarea";
import { pollTask, generateStyleRef } from "@/lib/style-ref-client";
```

Replace the `Props` interface:

```tsx
interface Props {
  categoryId: string;
  postType: "independent" | "narrative";
  styleRefUrl: string; // "" means no reference exists yet
  hasKieKey: boolean;
  onStyleRefGenerated: (url: string) => void;
}
```

Update the component signature:

```tsx
export function PreviewPane({ categoryId, postType, styleRefUrl, hasKieKey, onStyleRefGenerated }: Props) {
```

- [ ] **Step 3: Add regenerate state and wire `startTest()`**

Add new state, alongside the existing `run`/`busy`/`error` state:

```tsx
const [stageMessage, setStageMessage] = useState("");
const [notes, setNotes] = useState("");
const [regenerating, setRegenerating] = useState(false);
```

Replace the body of `startTest()`:

```tsx
async function startTest() {
  setBusy(true);
  setError("");
  setRun(null);
  setSelection({});
  setExcludedRoles(new Set());
  setPromoteState("idle");
  setPromoteError("");
  try {
    let refUrl = styleRefUrl;
    if (!refUrl) {
      setStageMessage("Generating a starter reference image for your brand…");
      refUrl = await generateStyleRef(categoryId);
      onStyleRefGenerated(refUrl);
    }
    setStageMessage("Generating your sample post…");
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
    setStageMessage("");
  }
}
```

- [ ] **Step 4: Replace the dead-end message and gate the button on `hasKieKey` alone**

Replace:

```tsx
{!hasKieKey && <p className="text-muted-foreground">Add your Kie.ai API key in Config to run tests.</p>}
{hasKieKey && !hasStyleRef && (
  <p className="text-muted-foreground">
    This draft has no brand visual reference image — add one on the start screen or in the category editor,
    then re-open the wizard.
  </p>
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
```

with:

```tsx
{!hasKieKey && <p className="text-muted-foreground">Add your Kie.ai API key in Config to run tests.</p>}
{hasKieKey && (
  <div className="space-y-2 border-b pb-3">
    <p className="text-xs font-medium text-muted-foreground">Brand reference image</p>
    {styleRefUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={styleRefUrl} alt="brand style reference" className="h-24 w-24 rounded border object-cover" />
    ) : (
      <p className="text-xs text-muted-foreground">
        None yet — one is generated automatically from your brand the first time you test this draft.
      </p>
    )}
    <div className="flex gap-2">
      <Textarea rows={1} placeholder="Optional notes for regenerating (e.g. more muted colors)"
        value={notes} onChange={(e) => setNotes(e.target.value)} className="text-xs" />
      <Button size="sm" variant="outline" disabled={regenerating}
        onClick={async () => {
          setRegenerating(true);
          setError("");
          try {
            const url = await generateStyleRef(categoryId, notes.trim() || undefined);
            onStyleRefGenerated(url);
            setNotes("");
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setRegenerating(false);
          }
        }}>
        {regenerating ? "Regenerating…" : "Regenerate"}
      </Button>
    </div>
  </div>
)}
{hasKieKey && (
  <div className="flex gap-2">
    <Button size="sm" onClick={startTest} disabled={busy}>
      {busy && !run ? (stageMessage || "Generating…") : run ? "Retry test" : "Test this draft"}
    </Button>
    {postType === "narrative" && run?.anchor.status === "done" && !run.fanout && (
      <Button size="sm" variant="outline" onClick={fullTest} disabled={busy}>
        Generate full test carousel
      </Button>
    )}
  </div>
)}
```

- [ ] **Step 5: Update `draft-wizard.tsx`'s call site**

In `app/(app)/config/draft/draft-wizard.tsx`, replace the `PreviewPane` usage:

```tsx
{categoryId && lastDraft && (
  <PreviewPane
    categoryId={categoryId}
    postType={lastDraft.post_type}
    hasStyleRef={!!brandRefUrl && !pendingStyleRef}
    hasKieKey={keys.kie}
  />
)}
```

with:

```tsx
{categoryId && lastDraft && (
  <PreviewPane
    categoryId={categoryId}
    postType={lastDraft.post_type}
    styleRefUrl={pendingStyleRef ? "" : brandRefUrl}
    hasKieKey={keys.kie}
    onStyleRefGenerated={(url) => { setBrandRefUrl(url); setPendingStyleRef(null); }}
  />
)}
```

The `pendingStyleRef ? "" : brandRefUrl` expression preserves the exact semantics the old `hasStyleRef` boolean had: a brand ref that's been uploaded but not yet sent with a chat turn must not be treated as the category's persisted reference.

- [ ] **Step 6: Verify it builds and the suite is green**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: no lint errors, no type errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/style-ref-client.ts "app/(app)/config/draft/preview-pane.tsx" "app/(app)/config/draft/draft-wizard.tsx"
git commit -m "feat: auto-generate a style reference on Test Run, add Regenerate"
```

---

### Task 4: Regenerate control in Config's category editor

**Files:**
- Modify: `app/(app)/config/page.tsx`
- Modify: `app/(app)/config/category-manager.tsx`

**Interfaces:**
- Consumes: `generateStyleRef` from `@/lib/style-ref-client` (Task 3).
- Produces: a "Regenerate with AI" control in `CategoryEditor`, reachable for any already-saved category when a Kie key is present.

**Context you need:** `app/(app)/config/page.tsx` already computes `const status = await getKeyStatus(user.id);` (shape `{anthropic: boolean; kie: boolean}`) and renders `<CategoryManager categories={...} groups={groups} brandDone={...} />` — you're adding one more prop using data already in scope, no new query. `CategoryManager` renders one `CategoryEditor` per existing category plus one blank `CategoryEditor` for creating a new one (around the file's line ~292 and ~307) — thread `hasKieKey` to all of them, but the Regenerate control itself only ever renders for an existing category (a category that doesn't exist yet has no `categoryId` to generate against).

Read `app/(app)/config/category-manager.tsx` in full before editing — in particular the existing `{form.style_ref_url && (<img .../>)}` block (around line 207-209) and the `set()` helper it already defines, which the new control reuses to keep the on-screen form in sync with what `finalize` already wrote to the database.

- [ ] **Step 1: Thread `hasKieKey` from the page**

In `app/(app)/config/page.tsx`, change the `<CategoryManager>` call to pass the Kie key status alongside the existing props:

```tsx
      <CategoryManager
        categories={(data ?? []) as Category[]}
        groups={groups}
        brandDone={Boolean((brandRow as BrandProfile | null)?.business_name?.trim())}
        hasKieKey={status.kie}
      />
```

- [ ] **Step 2: Thread `hasKieKey` through `CategoryManager` into `CategoryEditor`**

In `app/(app)/config/category-manager.tsx`, add `hasKieKey: boolean` to `CategoryManager`'s props type and destructure it in the signature. Pass it to both `CategoryEditor` call sites:

```tsx
{categories.map((c) => <CategoryEditor key={c.id} category={c} groups={groups} hasKieKey={hasKieKey} />)}
```

and

```tsx
<CategoryEditor groups={groups} hasKieKey={hasKieKey} />
```

Add `hasKieKey: boolean` to `CategoryEditor`'s own props type (`{ category, groups, hasKieKey }: { category?: Category; groups: ChannelGroup[]; hasKieKey: boolean }`).

- [ ] **Step 3: Add the Regenerate control**

Add this import at the top of `category-manager.tsx`:

```tsx
import { generateStyleRef } from "@/lib/style-ref-client";
```

Inside `CategoryEditor`, add local state alongside the existing `uploading`/`msg` state:

```tsx
const [styleRefNotes, setStyleRefNotes] = useState("");
const [regeneratingStyleRef, setRegeneratingStyleRef] = useState(false);
```

The existing "Style reference image" field currently reads:

```tsx
<div><Label>Style reference image</Label>
  <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="block text-sm" />
  {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
  {form.style_ref_url && (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={form.style_ref_url} alt="style ref" className="mt-2 h-40 rounded border object-cover" />
  )}
</div>
```

Insert the new control **inside that same `<div>`**, immediately after the `{form.style_ref_url && (...)}` block and before the enclosing `</div>` — not after the div closes:

```tsx
{category && hasKieKey && (
  <div className="mt-2 space-y-2">
    <Textarea rows={1} placeholder="Optional notes for regenerating (e.g. more muted colors)"
      value={styleRefNotes} onChange={(e) => setStyleRefNotes(e.target.value)} className="text-xs" />
    <Button type="button" size="sm" variant="outline" disabled={regeneratingStyleRef}
      onClick={async () => {
        setRegeneratingStyleRef(true);
        setMsg("");
        try {
          const url = await generateStyleRef(category.id, styleRefNotes.trim() || undefined);
          set("style_ref_url", url);
          setStyleRefNotes("");
        } catch (e) {
          setMsg(e instanceof Error ? e.message : String(e));
        } finally {
          setRegeneratingStyleRef(false);
        }
      }}>
      {regeneratingStyleRef ? "Regenerating…" : "Regenerate with AI"}
    </Button>
  </div>
)}
```

`category && hasKieKey` guards on two things: the control only makes sense for an already-saved category (a new, not-yet-created one has no `categoryId` to generate against), and only when a Kie key is configured. `generateStyleRef`'s `finalize` phase already wrote the new URL directly to `categories.style_ref_url` in the database — `set("style_ref_url", url)` here only keeps the on-screen form (and the existing Save button's payload) in sync with that write, so a subsequent Save doesn't silently revert the field to its old value.

- [ ] **Step 4: Verify it builds and the suite is green**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: no lint errors, no type errors, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config/page.tsx" "app/(app)/config/category-manager.tsx"
git commit -m "feat: regenerate a category's style reference from Config"
```

---

### Task 5: Fix the preview path's single-shot idea generation (Bug 2)

**Files:**
- Modify: `lib/athena/preview.ts`

**Interfaces:**
- Consumes: nothing new — this task only changes the internals of an existing exported function.
- Produces: `generateSamplePreviewIdea(userId: string, category: Category): Promise<{ concept: string; slides: Slide[] }>` — same signature, same return shape, unchanged for every caller.

**Context you need:** This bug is unrelated to the style-ref feature in Tasks 1-4; it was diagnosed separately. `lib/athena/preview.ts`'s `generateSamplePreviewIdea` currently asks Claude for exactly one idea and throws immediately if its slide shape doesn't match the category's `post_type` — e.g. "preview idea had the wrong shape: first slide must be 'hook', got 'single'". Compare `lib/athena/generate-ideas.ts`, which requests a *batch* of ideas and silently drops (`droppedForShape`) any that don't match shape, tolerating exactly this class of occasional LLM mislabel. The preview path never got that same tolerance. Read both files' current handling of `validateSlideShape` before editing — this task's fix is a bounded retry loop around the single-idea call, not a batch request (a preview only ever wants one idea).

This task has no new automated test: it changes the internals of a function that makes a live Anthropic call, and this repo has no live-LLM tests anywhere (consistent with every other Kie/Anthropic-calling function here). Verify via typecheck, the existing suite, and the manual check in this task's own Step 4.

- [ ] **Step 1: Replace `generateSamplePreviewIdea`'s body with a bounded retry loop**

In `lib/athena/preview.ts`, add this constant near `PREVIEW_IDEA_MAX_TOKENS`:

```ts
// Mirrors this codebase's other bounded-tolerance windows (e.g.
// MAX_CONSECUTIVE_POLL_ERRORS in the polling helper) — each attempt is a
// fresh, real generation call, so this is not unbounded retry. The batch
// idea-generation path (generate-ideas.ts) tolerates exactly this same class
// of occasional malformed slide shape by requesting many ideas and dropping
// the bad ones; a preview only ever wants one idea, so it retries instead.
const MAX_PREVIEW_ATTEMPTS = 3;
```

Replace the body of `generateSamplePreviewIdea` from the `const anthropic = ...` line onward:

```ts
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
    proof_points: brandRow?.proof_points ?? [],
    standing: brandRow?.standing ?? [],
    colors: brandRow?.colors ?? [],
    fonts: brandRow?.fonts ?? [],
    visual_notes: brandRow?.visual_notes ?? "",
  };

  const anthropic = createAnthropicClient({
    apiKey: await requireAnthropicKey(userId),
    feature: "content_preview",
  });

  const expected = category.post_type === "narrative" ? category.images_per_carousel : 1;
  let lastReason = "no usable idea returned";
  for (let attempt = 1; attempt <= MAX_PREVIEW_ATTEMPTS; attempt++) {
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: PREVIEW_IDEA_MAX_TOKENS,
      system: buildIdeaSystemPrompt(brand, [category]),
      messages: [{ role: "user", content: buildIdeaUserPrompt(1, [category.key]) }],
      output_config: { format: zodOutputFormat(IdeasOutput) },
    });
    const idea = response.parsed_output?.ideas?.[0];
    if (!idea) {
      lastReason = "no usable idea returned";
      continue;
    }
    const slides = (idea.slides ?? []) as Slide[];
    const shape = validateSlideShape(slides, expected);
    if (shape.ok) return { concept: idea.concept, slides };
    console.warn(`preview idea attempt ${attempt}/${MAX_PREVIEW_ATTEMPTS} had the wrong shape: ${shape.reason}`);
    lastReason = shape.reason;
  }
  throw new Error(`preview idea had the wrong shape after ${MAX_PREVIEW_ATTEMPTS} attempts: ${lastReason}`);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all existing tests pass unchanged (this function has no unit test today, consistent with every other live-Anthropic-calling function in this repo).

- [ ] **Step 4: Manual verification note for the final checklist**

This fix cannot be exercised by the automated suite (it requires a live Anthropic call that occasionally mislabels a slide role — not something to force deterministically). Carry it into the plan's Final Verification as a live check: run Test Run against a narrative category enough times to trust the retry loop is actually reached at least once without an immediate hard failure, or accept that this is validated by the error message changing (`... after 3 attempts: ...`) the next time this class of mislabel occurs in production.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/preview.ts
git commit -m "fix: retry the preview path's single idea generation on a bad slide shape"
```

---

## Final verification

- [ ] **Run the full suite:** `npm test` — every test passes.
- [ ] **Typecheck:** `npx tsc --noEmit` — clean.
- [ ] **Lint:** `npm run lint` — clean.
- [ ] **Build:** `npm run build` — succeeds.
- [ ] **Manual, with real keys — the core new flow:** open the wizard for a category with no reference image (or unset one via Config first). Click "Test this draft." Confirm the staged messages appear in order ("Generating a starter reference image for your brand…" then "Generating your sample post…"), a reference thumbnail appears once done, and the sample post generates against it. Confirm `categories.style_ref_url` is set in Supabase afterward.
- [ ] **Manual: Regenerate, both surfaces.** In the wizard, type a note and click "Regenerate" — confirm the thumbnail updates and a subsequent Test Run uses the new image. In Config's category editor, do the same for an existing category and confirm the field updates on screen and Save isn't required for the database to already reflect it.
- [ ] **Manual: thin brand profile.** Test Run against a category whose brand has no scraped colors/fonts/visual_notes at all — confirm generation still proceeds (fallback prompt) rather than blocking.
- [ ] **Manual: Bug 2's fix.** If a narrative category's Test Run previously failed with a "wrong shape" error, retry it a few times and confirm it either succeeds or, on repeated failure, reports the error with "after 3 attempts" in the message rather than failing on the very first roll.
