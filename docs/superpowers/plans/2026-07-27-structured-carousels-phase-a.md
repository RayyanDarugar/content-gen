# Structured Carousels — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an idea carry an ordered array of slides, and generate every slide of a carousel so they read as one post — anchored to a shared reference image.

**Architecture:** Slides live as `jsonb` on `ideas`. Image generation becomes two-phase: `submitGenerations` submits only slide 0, and the existing poll cron fans out the remaining slides once the anchor image lands, referencing `[styleUrl, anchorImage]`. Each fanned-out generation records `anchor_generation_id` so carousel membership is explicit rather than inferred. Phase A ends when correct slides exist in the database with all their images generated; posting and UI are Phase B.

**Tech Stack:** Next.js 16 (App Router), Supabase (Postgres + RLS), Anthropic SDK with zod structured output, Kie.ai `gpt-image-2-image-to-image`, Cloudinary for image hosting, vitest.

**Spec:** `docs/superpowers/specs/2026-07-27-structured-carousels-design.md`

## Global Constraints

- **This change is strictly additive.** Every existing workflow — hand-picking and reordering arbitrary images in `/post`, approve/reject, retry, regenerate-with-notes — must still work when Phase A lands. Removing a capability is a failed task.
- **Migrations are applied manually by Rayyan** against the Supabase project, as in every prior phase. A task that needs a migration applied must say so explicitly and stop.
- **Service-role paths must set and filter `user_id` explicitly.** `createAdminSupabase()` bypasses RLS, so tenant isolation is the caller's job. Every new query follows the existing pattern.
- **Every post is a slide array; length 1 is a single image.** No legacy branch — `NOTES_APP` is already a one-image category and must flow through the same code.
- **`refinementNotes` must survive.** `regenerate-with-notes` is a shipped feature; `buildSlidePrompt` keeps the parameter.
- **Never delete generation rows.** Failed and superseded generations are retained as history. "Newest wins" is the rule, not deletion.
- Repo conventions: vitest with the `@/` alias, conventional-commit messages, `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` on every commit.

## File Structure

| file | responsibility |
|---|---|
| `supabase/migrations/0008_structured_carousels.sql` | schema + backfill |
| `lib/types.ts` | `Slide`, and the new columns on `Idea`/`Generation`/`Post` |
| `lib/athena/slides.ts` | **new** — pure slide-shape validation |
| `lib/athena/fanout.ts` | **new** — pure fan-out and completion decisions |
| `lib/athena/image-prompt.ts` | `buildSlidePrompt` replaces `buildImagePrompt` |
| `lib/athena/kie.ts` | `createKieTask` takes `inputUrls: string[]` |
| `lib/athena/submit-generations.ts` | submits slide 0 only |
| `app/api/jobs/poll/route.ts` | fan-out; idea completes only when all slides succeed |
| `lib/athena/prompts.ts` | carousel output schema + instructions |
| `lib/athena/generate-ideas.ts` | validate shape, insert slides |
| `app/(app)/ideas/actions.ts` | `createManualIdea` server action |
| `app/(app)/ideas/manual-idea-dialog.tsx` | **new** — hand-authoring UI |
| `lib/athena/carousel.ts` | default fill skips multi-slide ideas; pool ungated |

`slides.ts` and `fanout.ts` are new files rather than additions to existing ones because both are pure decision logic that wants unit tests without a database — the same split that makes `poll-logic.ts` and `filter.ts` testable today.

---

### Task 1: Verify Cloudinary URLs work as Kie `input_urls`

The entire fan-out rests on passing a Cloudinary URL as the second reference. Testing only ever chained on raw Kie result URLs. If this fails, the design changes (the anchor would have to be re-uploaded via `uploadStyleRef` first), so it is verified before anything is built on it.

**Files:**
- Create (temporary, deleted in step 4): `scripts/verify-cloudinary-ref.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a documented yes/no that Task 6 depends on

- [ ] **Step 1: Write the spike script**

```ts
// scripts/verify-cloudinary-ref.ts
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const KIE_KEY = process.env.KIE_API_KEY!;
const headers = { Authorization: `Bearer ${KIE_KEY}`, "Content-Type": "application/json" };

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  // Any already-succeeded generation gives us a real Cloudinary URL.
  const { data: gen } = await db
    .from("generations").select("public_url")
    .eq("status", "succeeded").like("public_url", "%cloudinary%")
    .limit(1).single();
  const { data: cat } = await db
    .from("categories").select("style_ref_url, aspect_ratio")
    .eq("key", "BEAGLE_EXPLAINS").limit(1).single();

  console.log("anchor (cloudinary):", gen!.public_url);

  const res = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST", headers,
    body: JSON.stringify({
      model: "gpt-image-2-image-to-image",
      input: {
        prompt: "A cute beagle at a desk, warm cream background, matching the second reference image's palette and typography.",
        input_urls: [cat!.style_ref_url, gen!.public_url],
        aspect_ratio: cat!.aspect_ratio,
      },
    }),
  });
  const json = await res.json();
  const taskId = json?.data?.taskId;
  if (!taskId) { console.log("REJECTED AT SUBMIT:", JSON.stringify(json).slice(0, 400)); return; }

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const rr = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, { headers });
    const rj = await rr.json();
    const state = rj?.data?.state ?? "unknown";
    if (state === "success") {
      console.log("SUCCESS:", JSON.parse(rj.data.resultJson).resultUrls?.[0]);
      return;
    }
    if (state === "fail") { console.log("FAILED:", rj?.data?.failMsg); return; }
  }
  console.log("TIMEOUT");
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/verify-cloudinary-ref.ts`
Expected: `SUCCESS: <url>`.

Note Kie fails intermittently (~10% at this prompt length, higher for long prompts). A single `FAILED: Internal Error, Please try again later.` is not a result — **run it three times** before concluding anything. `REJECTED AT SUBMIT` is different and *is* conclusive: it means the URL was refused outright.

- [ ] **Step 3: Record the outcome**

If it succeeds, add one line to the spec's §7 risk 1 marking it verified with the date, and continue.

**If it is rejected at submit or fails all three runs, STOP and report.** Task 6 would need to `uploadStyleRef` the anchor to Kie's own storage first and store that URL, which changes the fan-out design. Do not guess around it.

- [ ] **Step 4: Delete the spike and commit the spec note**

```bash
rm scripts/verify-cloudinary-ref.ts
git add docs/superpowers/specs/2026-07-27-structured-carousels-design.md
git commit -m "$(cat <<'EOF'
docs: confirm Cloudinary URLs are accepted as Kie input_urls

The fan-out passes the anchor image as a second reference, and the anchor
is a Cloudinary URL rather than the raw Kie result URL chaining was tested
against. Verified before building on it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 0008 and types

**Files:**
- Create: `supabase/migrations/0008_structured_carousels.sql`
- Modify: `lib/types.ts`

**Interfaces:**
- Produces: `Slide` type; `Idea.slides`, `Generation.slide_index`, `Generation.anchor_generation_id`, `Post.idea_id`. Every later task depends on these.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0008_structured_carousels.sql
-- A post becomes one structured unit: an idea carries an ordered array of
-- slides, and each generation names both its slide and the anchor image it
-- was generated against.

alter table ideas add column slides jsonb not null default '[]'::jsonb;

alter table generations add column slide_index int not null default 0;
create index generations_idea_slide_idx on generations(idea_id, slide_index);

-- Which slide-0 image this slide was generated against. Null for slide 0
-- itself and for legacy/single-slide rows. Makes carousel membership
-- explicit so regenerating an anchor can't silently orphan its siblings.
alter table generations add column anchor_generation_id uuid references generations(id);
create index generations_anchor_idx on generations(anchor_generation_id);

-- Null means the post was hand-assembled from the freeform pool; non-null
-- means the post is that carousel. Legacy posts stay null — each of them
-- groups five unrelated ideas, so they have no single owning idea.
alter table posts add column idea_id uuid references ideas(id);

-- Legacy ideas become single-slide carousels so there is exactly one code
-- path. These are historical records, not regeneration targets: a legacy
-- BEAGLE_EXPLAINS idea correctly ends up with one slide despite its
-- category's images_per_carousel = 5, because one image is what it produced.
update ideas
set slides = jsonb_build_array(
  jsonb_build_object('role', 'single', 'text', '', 'visual', concept))
where slides = '[]'::jsonb and concept <> '';
```

- [ ] **Step 2: Update types**

In `lib/types.ts`, add `Slide` and extend the three interfaces:

```ts
export interface Slide {
  role: "hook" | "beat" | "payoff" | "single";
  text: string;   // the words that appear on the panel
  visual: string; // scene, camera angle, subject pose
}
```

Add `slides: Slide[];` to `Idea`. Add `slide_index: number;` and `anchor_generation_id: string | null;` to `Generation`. Add `idea_id: string | null;` to `Post`.

- [ ] **Step 3: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: clean. Nothing reads the new fields yet, so nothing breaks.

- [ ] **Step 4: STOP — Rayyan applies the migration**

Report that `0008` is ready and must be applied to the Supabase project before Task 6 can be verified live. Tasks 3–5 are pure and need no database, so they can proceed meanwhile.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0008_structured_carousels.sql lib/types.ts
git commit -m "$(cat <<'EOF'
feat: migration 0008 - slides, slide_index, anchor_generation_id

Legacy ideas backfill to single-slide carousels so there is one code path
rather than a legacy branch. anchor_generation_id records which slide-0
image a slide was built against, which is what lets a regenerated anchor
avoid silently orphaning its siblings.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Slide shape validation

**Files:**
- Create: `lib/athena/slides.ts`
- Test: `tests/slides.test.ts`

**Interfaces:**
- Consumes: `Slide` from Task 2
- Produces: `validateSlideShape(slides: Slide[], expectedCount: number): { ok: boolean; reason: string }` — used by Task 9 (generated ideas) and Task 8 (manual authoring)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/slides.test.ts
import { describe, it, expect } from "vitest";
import { validateSlideShape } from "@/lib/athena/slides";
import type { Slide } from "@/lib/types";

const s = (role: Slide["role"], text = "t", visual = "v"): Slide => ({ role, text, visual });

describe("validateSlideShape", () => {
  it("accepts hook + beats + payoff at the expected count", () => {
    const slides = [s("hook"), s("beat"), s("beat"), s("beat"), s("payoff")];
    expect(validateSlideShape(slides, 5)).toEqual({ ok: true, reason: "" });
  });

  it("accepts a lone single slide", () => {
    expect(validateSlideShape([s("single")], 1)).toEqual({ ok: true, reason: "" });
  });

  it("rejects an empty array", () => {
    expect(validateSlideShape([], 5).ok).toBe(false);
  });

  it("rejects the wrong slide count", () => {
    const slides = [s("hook"), s("beat"), s("payoff")];
    expect(validateSlideShape(slides, 5)).toEqual({
      ok: false,
      reason: "expected 5 slides, got 3",
    });
  });

  it("rejects a first slide that is not a hook", () => {
    const slides = [s("beat"), s("beat"), s("payoff")];
    expect(validateSlideShape(slides, 3).ok).toBe(false);
  });

  it("rejects a last slide that is not a payoff", () => {
    const slides = [s("hook"), s("beat"), s("beat")];
    expect(validateSlideShape(slides, 3).ok).toBe(false);
  });

  it("rejects a non-beat in the middle", () => {
    const slides = [s("hook"), s("payoff"), s("payoff")];
    expect(validateSlideShape(slides, 3).ok).toBe(false);
  });

  it("requires role 'single' when the count is 1", () => {
    expect(validateSlideShape([s("hook")], 1).ok).toBe(false);
  });

  it("rejects a slide with neither text nor visual", () => {
    const slides = [s("hook"), s("beat", "", ""), s("payoff")];
    expect(validateSlideShape(slides, 3).ok).toBe(false);
  });

  it("allows a slide with a visual but no text (a wordless panel)", () => {
    const slides = [s("hook"), s("beat", "", "a wide empty desk"), s("payoff")];
    expect(validateSlideShape(slides, 3).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/slides.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/slides`.

- [ ] **Step 3: Implement**

```ts
// lib/athena/slides.ts
import type { Slide } from "@/lib/types";

export interface ShapeResult {
  ok: boolean;
  reason: string;
}

const OK: ShapeResult = { ok: true, reason: "" };

// A carousel is one story: a hook, some beats, a payoff. A single image is
// the same shape with one slide. Malformed carousels are discarded rather
// than repaired — a persistent failure rate here is a prompt problem.
export function validateSlideShape(slides: Slide[], expectedCount: number): ShapeResult {
  if (!Array.isArray(slides) || slides.length === 0) {
    return { ok: false, reason: "no slides" };
  }
  if (slides.length !== expectedCount) {
    return { ok: false, reason: `expected ${expectedCount} slides, got ${slides.length}` };
  }
  if (slides.some((slide) => !slide.text.trim() && !slide.visual.trim())) {
    return { ok: false, reason: "a slide has neither text nor visual" };
  }
  if (expectedCount === 1) {
    return slides[0].role === "single"
      ? OK
      : { ok: false, reason: `a one-slide carousel must use role "single", got "${slides[0].role}"` };
  }
  const roles = slides.map((slide) => slide.role);
  if (roles[0] !== "hook") {
    return { ok: false, reason: `first slide must be "hook", got "${roles[0]}"` };
  }
  if (roles[roles.length - 1] !== "payoff") {
    return { ok: false, reason: `last slide must be "payoff", got "${roles[roles.length - 1]}"` };
  }
  const middle = roles.slice(1, -1);
  if (!middle.every((role) => role === "beat")) {
    return { ok: false, reason: `middle slides must all be "beat", got [${middle.join(", ")}]` };
  }
  return OK;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/slides.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/slides.ts tests/slides.test.ts
git commit -m "$(cat <<'EOF'
feat: slide shape validation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `buildSlidePrompt`

> **Ruling (Rayyan, 2026-07-27): Tasks 4 and 5 are implemented and committed as one unit.**
> Renaming `buildImagePrompt` without updating its caller leaves an intermediate commit where
> `tsc` fails. The multi-tenant Phase B plan hit this exact situation and merged its two tasks
> for the same reason. Do all of Task 4 and Task 5, run the verification from Task 5 Step 3,
> and make a single commit using Task 5's message. Ignore Task 4 Step 5's separate commit and
> its note that the typecheck is expected to fail.

**Files:**
- Modify: `lib/athena/image-prompt.ts` (replaces `buildImagePrompt`)
- Modify: `tests/image-prompt.test.ts` (rewrite)

**Interfaces:**
- Consumes: `Slide` from Task 2
- Produces: `buildSlidePrompt(styleGuide: string, slide: Slide, position: number, total: number, chained: boolean, refinementNotes?: string): string` — used by Tasks 5 and 6

Tests assert structure and the specific behaviours that matter, not one exact giant string. A full-string equality test on a multi-paragraph prompt breaks on every wording tweak while catching nothing a targeted assertion misses.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `tests/image-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import type { Slide } from "@/lib/types";

const slide: Slide = { role: "beat", text: "So I did more.", visual: "Overhead desk view." };

describe("buildSlidePrompt", () => {
  it("leads with the style guide", () => {
    expect(buildSlidePrompt("GUIDE", slide, 2, 5, true).startsWith("GUIDE\n")).toBe(true);
  });

  it("includes the panel text and scene", () => {
    const p = buildSlidePrompt("GUIDE", slide, 2, 5, true);
    expect(p).toContain('Text on panel: "So I did more."');
    expect(p).toContain("Scene: Overhead desk view.");
  });

  it("states the panel position for a multi-slide carousel", () => {
    expect(buildSlidePrompt("GUIDE", slide, 2, 5, true)).toContain("Panel 2 of 5.");
  });

  it("omits panel position for a single-image post", () => {
    const single: Slide = { role: "single", text: "T", visual: "V" };
    expect(buildSlidePrompt("GUIDE", single, 1, 1, false)).not.toContain("Panel 1 of 1");
  });

  it("uses the one-reference note when unchained", () => {
    const p = buildSlidePrompt("GUIDE", slide, 1, 5, false);
    expect(p).toContain("Reference the provided style image");
    expect(p).not.toContain("Two reference images");
  });

  it("uses the two-reference note when chained", () => {
    const p = buildSlidePrompt("GUIDE", slide, 2, 5, true);
    expect(p).toContain("Two reference images are provided");
    expect(p).toContain("SECOND is the opening panel");
  });

  it("varies role direction by role", () => {
    const hook = buildSlidePrompt("G", { ...slide, role: "hook" }, 1, 5, false);
    const payoff = buildSlidePrompt("G", { ...slide, role: "payoff" }, 5, 5, true);
    expect(hook).toContain("ROLE DIRECTION:");
    expect(payoff).toContain("ROLE DIRECTION:");
    expect(hook).not.toBe(payoff);
  });

  it("carries refinement notes when present", () => {
    const p = buildSlidePrompt("G", slide, 2, 5, true, "make the dog bigger");
    expect(p).toContain("Refinement notes: make the dog bigger");
  });

  it("treats empty refinement notes as absent", () => {
    expect(buildSlidePrompt("G", slide, 2, 5, true, "")).toBe(
      buildSlidePrompt("G", slide, 2, 5, true),
    );
  });

  it("does not name a footer — that belongs to the style guide", () => {
    expect(buildSlidePrompt("GUIDE", slide, 2, 5, true).toLowerCase()).not.toContain("footer");
  });

  it("omits the text line entirely for a wordless panel", () => {
    const wordless: Slide = { role: "beat", text: "", visual: "An empty desk." };
    expect(buildSlidePrompt("G", wordless, 2, 5, true)).not.toContain("Text on panel:");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/image-prompt.test.ts`
Expected: FAIL — `buildSlidePrompt` is not exported.

- [ ] **Step 3: Implement**

Replace `lib/athena/image-prompt.ts` entirely:

```ts
import type { Slide } from "@/lib/types";

// Kept deliberately short. Testing showed the reference image overrides
// art-direction prose, so long stylistic instructions here buy nothing and
// push the prompt toward Kie's flaky length range.
const ROLE_DIRECTION: Record<Slide["role"], string> = {
  hook:
    "This is the anchor panel. Establish the palette, lettering, subject appearance, and " +
    "any persistent elements — every later panel matches this one.",
  beat:
    "Middle story beat. Match the reference panels exactly for palette, lettering, subject " +
    "appearance, and persistent elements, but the camera angle and pose must differ from " +
    "every other panel.",
  payoff:
    "Payoff panel. Highest emotional register in the set, and the tightest crop of the " +
    "carousel. Same palette, lettering, subject, and persistent elements as the references.",
  single:
    "A single standalone image, not part of a sequence. It must work alone.",
};

const ONE_REFERENCE =
  "Reference the provided style image to maintain visual consistency in palette, " +
  "illustration style, and layout.";

// Verbatim from the wording that held identity across five slides in testing.
const TWO_REFERENCES =
  "Two reference images are provided. The FIRST is the brand style reference. The SECOND " +
  "is the opening panel of this exact carousel — match its palette, typography, subject " +
  "appearance, and any persistent elements precisely, while following the camera and pose " +
  "direction above.";

export function buildSlidePrompt(
  styleGuide: string,
  slide: Slide,
  position: number,
  total: number,
  chained: boolean,
  refinementNotes = "",
): string {
  const lines: string[] = [styleGuide, "", "SPECIFIC CONTENT FOR THIS IMAGE:"];
  if (total > 1) lines.push(`Panel ${position} of ${total}.`, "");
  if (slide.text.trim()) lines.push(`Text on panel: "${slide.text}"`);
  if (slide.visual.trim()) lines.push(`Scene: ${slide.visual}`);
  lines.push(
    "",
    "Follow every rule in the style guide, including any element it specifies as appearing " +
      "on every panel.",
  );
  if (refinementNotes) lines.push("", `Refinement notes: ${refinementNotes}`);
  lines.push("", `ROLE DIRECTION: ${ROLE_DIRECTION[slide.role]}`);
  lines.push("", chained ? TWO_REFERENCES : ONE_REFERENCE);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/image-prompt.test.ts`
Expected: PASS, 11 tests. `npx tsc --noEmit` will now fail in `submit-generations.ts` — that is expected and fixed in Task 5.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/image-prompt.ts tests/image-prompt.test.ts
git commit -m "$(cat <<'EOF'
feat: buildSlidePrompt replaces buildImagePrompt

Role direction is kept short: testing showed the reference image overrides
art-direction prose, so long stylistic instruction buys nothing and pushes
the prompt toward Kie's flaky length range. The footer rule is expressed
generically ("any element the style guide specifies on every panel") rather
than hardcoding a concept only one category uses.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `createKieTask` takes multiple references; submit slide 0 only

> **Implemented together with Task 4 as one commit — see the ruling under Task 4.**

**Files:**
- Modify: `lib/athena/kie.ts:31-53` (`createKieTask`)
- Modify: `lib/athena/submit-generations.ts`

**Interfaces:**
- Consumes: `buildSlidePrompt` (Task 4), `Slide` (Task 2)
- Produces: `createKieTask(apiKey: string, prompt: string, inputUrls: string[], aspectRatio: string): Promise<string>`; `submitGenerations` unchanged in signature, changed in behaviour

- [ ] **Step 1: Change `createKieTask`**

In `lib/athena/kie.ts`, change the third parameter from `styleUrl: string` to `inputUrls: string[]` and the body from `input_urls: [styleUrl]` to `input_urls: inputUrls`. Leave everything else alone.

- [ ] **Step 2: Submit only slide 0**

In `lib/athena/submit-generations.ts`, inside the `for (const idea of eligible)` loop, replace the prompt construction and task creation. The style-ref upload and caching above it stay exactly as they are.

```ts
      const slides = (idea.slides ?? []) as Slide[];
      if (!slides.length) throw new Error("idea has no slides");

      // Only the anchor is submitted here. The poll cron fans out the rest
      // once this image exists, because they reference it.
      const anchor = slides[0];
      const fullPrompt = buildSlidePrompt(
        category.style_guide, anchor, 1, slides.length, false, refinementNotes);
      const taskId = await createKieTask(kieKey, fullPrompt, [styleUrl], category.aspect_ratio);
      const { error: insErr } = await supabase.from("generations").insert({
        user_id: userId,
        idea_id: idea.id,
        kie_task_id: taskId,
        status: "submitted",
        slide_index: 0,
        kie_style_url: styleUrl,
        full_prompt: fullPrompt,
        refinement_notes: refinementNotes,
      });
```

Update the imports: `buildSlidePrompt` instead of `buildImagePrompt`, and add `Slide` to the type import.

- [ ] **Step 3: Verify the build**

Run: `npx tsc --noEmit && npm test`
Expected: typecheck clean, 42 tests pass (32 existing + 10 from Task 3; Task 4 replaced 3 with 11).

- [ ] **Step 4: Commit**

```bash
git add lib/athena/kie.ts lib/athena/submit-generations.ts
git commit -m "$(cat <<'EOF'
feat: submit only the anchor slide; createKieTask takes multiple refs

Slides 2..N reference the anchor image, so they cannot be submitted until it
exists. The poll cron fans them out.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Fan-out and completion decisions

**Files:**
- Create: `lib/athena/fanout.ts`
- Test: `tests/fanout.test.ts`

**Interfaces:**
- Produces: `shouldFanOut(slideCount: number, existingUnderAnchor: number): boolean`, `slideIndexesToFanOut(slideCount: number): number[]`, `isCarouselComplete(slideCount: number, succeededIndexes: number[]): boolean`, `shouldRetryAnchor(anchorAttempts: number, anchorSucceeded: boolean): boolean` — all used by Task 7

- [ ] **Step 1: Write the failing tests**

```ts
// tests/fanout.test.ts
import { describe, it, expect } from "vitest";
import { shouldFanOut, slideIndexesToFanOut, isCarouselComplete } from "@/lib/athena/fanout";

describe("shouldFanOut", () => {
  it("fans out a multi-slide carousel with no siblings yet", () => {
    expect(shouldFanOut(5, 0)).toBe(true);
  });

  it("does not fan out a single-slide post", () => {
    expect(shouldFanOut(1, 0)).toBe(false);
  });

  it("does not fan out twice for the same anchor", () => {
    expect(shouldFanOut(5, 4)).toBe(false);
  });

  it("does not fan out when even one sibling exists (partial prior run)", () => {
    expect(shouldFanOut(5, 1)).toBe(false);
  });
});

describe("slideIndexesToFanOut", () => {
  it("returns every index except the anchor", () => {
    expect(slideIndexesToFanOut(5)).toEqual([1, 2, 3, 4]);
  });

  it("returns nothing for a single-slide post", () => {
    expect(slideIndexesToFanOut(1)).toEqual([]);
  });
});

describe("isCarouselComplete", () => {
  it("is complete when every index succeeded", () => {
    expect(isCarouselComplete(5, [0, 1, 2, 3, 4])).toBe(true);
  });

  it("is incomplete when one is missing", () => {
    expect(isCarouselComplete(5, [0, 1, 2, 4])).toBe(false);
  });

  it("ignores duplicates from retries", () => {
    expect(isCarouselComplete(3, [0, 0, 1, 2, 2])).toBe(true);
  });

  it("is complete for a single slide", () => {
    expect(isCarouselComplete(1, [0])).toBe(true);
  });

  it("is incomplete with no successes", () => {
    expect(isCarouselComplete(3, [])).toBe(false);
  });
});

describe("shouldRetryAnchor", () => {
  it("retries a failed first attempt", () => {
    expect(shouldRetryAnchor(1, false)).toBe(true);
  });

  it("retries a failed second attempt", () => {
    expect(shouldRetryAnchor(2, false)).toBe(true);
  });

  it("gives up after three attempts", () => {
    expect(shouldRetryAnchor(3, false)).toBe(false);
  });

  it("never retries once an anchor has succeeded", () => {
    expect(shouldRetryAnchor(1, true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/fanout.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/fanout`.

- [ ] **Step 3: Implement**

```ts
// lib/athena/fanout.ts

// The cron runs repeatedly and a retried anchor produces a second slide-0
// generation, so "did the anchor just succeed" is not a safe trigger. The
// guard is keyed on the anchor itself rather than on "does this idea have
// any slide above index 0" — the weaker version would let an earlier run's
// slides block every subsequent re-anchor forever.
export function shouldFanOut(slideCount: number, existingUnderAnchor: number): boolean {
  return slideCount > 1 && existingUnderAnchor === 0;
}

export function slideIndexesToFanOut(slideCount: number): number[] {
  return Array.from({ length: Math.max(0, slideCount - 1) }, (_, i) => i + 1);
}

// An idea is only "generated" once every slide has an image. It used to flip
// on the first one, which was correct when an idea meant one image.
export function isCarouselComplete(slideCount: number, succeededIndexes: number[]): boolean {
  const succeeded = new Set(succeededIndexes);
  for (let i = 0; i < slideCount; i++) {
    if (!succeeded.has(i)) return false;
  }
  return true;
}

export const MAX_ANCHOR_ATTEMPTS = 3;

// The anchor gates every other slide, so a flaky failure there stalls the
// whole carousel rather than costing one image. Kie fails intermittently in
// proportion to prompt length — measured at ~40% on the longest style guide
// and ~10% elsewhere — so the anchor gets automatic retries where middle
// slides rely on the manual retry that already exists.
export function shouldRetryAnchor(anchorAttempts: number, anchorSucceeded: boolean): boolean {
  if (anchorSucceeded) return false;
  return anchorAttempts < MAX_ANCHOR_ATTEMPTS;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/fanout.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/fanout.ts tests/fanout.test.ts
git commit -m "$(cat <<'EOF'
feat: fan-out and carousel-completion decisions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire fan-out into the poll route

**Files:**
- Modify: `app/api/jobs/poll/route.ts` (`ingestImage`, and the loop body)

**Interfaces:**
- Consumes: `shouldFanOut`, `slideIndexesToFanOut`, `isCarouselComplete` (Task 6); `buildSlidePrompt` (Task 4); `createKieTask` (Task 5)
- Produces: the live two-phase pipeline

- [ ] **Step 1: Replace `ingestImage`**

It currently marks the generation succeeded and flips the idea to `generated` unconditionally. It must now flip the idea only when every slide has an image, and fan out when it has just ingested an anchor.

```ts
async function ingestImage(
  supabase: SupabaseClient,
  gen: Generation,
  resultUrl: string,
): Promise<void> {
  const res = await fetch(resultUrl);
  if (!res.ok) throw new Error(`image download failed (HTTP ${res.status})`);
  const original = Buffer.from(await res.arrayBuffer());
  const jpeg = await sharp(original).jpeg({ quality: 90 }).toBuffer();
  const { publicId, url } = await uploadImageToCloudinary(jpeg, "image/jpeg");
  const { error: rowErr } = await supabase
    .from("generations")
    .update({ status: "succeeded", image_path: publicId, public_url: url })
    .eq("id", gen.id);
  if (rowErr) throw new Error(`generation update failed: ${rowErr.message}`);

  const { data: ideaRow, error: ideaErr } = await supabase
    .from("ideas").select("*").eq("id", gen.idea_id).single();
  if (ideaErr || !ideaRow) throw new Error(`idea lookup failed: ${ideaErr?.message}`);
  const idea = ideaRow as Idea;
  const slideCount = (idea.slides ?? []).length || 1;

  // Fan out the rest of the carousel against this anchor.
  if (gen.slide_index === 0) {
    const { count, error: sibErr } = await supabase
      .from("generations")
      .select("*", { count: "exact", head: true })
      .eq("anchor_generation_id", gen.id);
    if (sibErr) throw new Error(`sibling count failed: ${sibErr.message}`);
    if (shouldFanOut(slideCount, count ?? 0)) {
      await fanOutCarousel(supabase, gen, idea, url);
    }
  }

  // The idea completes only when every slide has an image.
  const { data: doneRows, error: doneErr } = await supabase
    .from("generations")
    .select("slide_index")
    .eq("idea_id", gen.idea_id)
    .eq("status", "succeeded");
  if (doneErr) throw new Error(`completion query failed: ${doneErr.message}`);
  const succeeded = (doneRows ?? []).map((r) => r.slide_index as number);
  if (isCarouselComplete(slideCount, succeeded)) {
    await supabase.from("ideas").update({ status: "generated" }).eq("id", gen.idea_id);
  }
}
```

- [ ] **Step 2: Add the fan-out helper**

Directly below `ingestImage`:

```ts
// Submits slides 1..N-1 against the anchor image. Each records
// anchor_generation_id so carousel membership survives a later re-anchor.
async function fanOutCarousel(
  supabase: SupabaseClient,
  anchor: Generation,
  idea: Idea,
  anchorImageUrl: string,
): Promise<void> {
  const apiKey = await getKieKeyOrNull(anchor.user_id);
  if (!apiKey) return; // owner removed their key; a later tick retries

  const { data: catRow } = await supabase
    .from("categories").select("*")
    .eq("user_id", anchor.user_id).eq("key", idea.category_key).single();
  if (!catRow) throw new Error(`category ${idea.category_key} not found`);
  const category = catRow as Category;
  const slides = idea.slides;

  for (const index of slideIndexesToFanOut(slides.length)) {
    const prompt = buildSlidePrompt(
      category.style_guide, slides[index], index + 1, slides.length, true,
      anchor.refinement_notes);
    try {
      const taskId = await createKieTask(
        apiKey, prompt, [anchor.kie_style_url, anchorImageUrl], category.aspect_ratio);
      await supabase.from("generations").insert({
        user_id: anchor.user_id,
        idea_id: idea.id,
        kie_task_id: taskId,
        status: "submitted",
        slide_index: index,
        anchor_generation_id: anchor.id,
        kie_style_url: anchor.kie_style_url,
        full_prompt: prompt,
        refinement_notes: anchor.refinement_notes,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await supabase.from("generations").insert({
        user_id: anchor.user_id,
        idea_id: idea.id,
        status: "failed",
        slide_index: index,
        anchor_generation_id: anchor.id,
        error: message,
      });
    }
  }
}
```

- [ ] **Step 3: Fix the failure path**

The loop's `decision.action === "fail"` branch currently marks the whole idea failed on any slide failure. One dud slide should not condemn the carousel — the gallery offers a retry, and Phase B's freeform pool keeps the good slides usable. Leave the generation marked failed and stop touching the idea:

```ts
      } else if (decision.action === "fail") {
        failed++;
        await supabase
          .from("generations")
          .update({ status: "failed", error: decision.error })
          .eq("id", gen.id);
        // The idea is deliberately left alone. A failed slide is retryable,
        // and marking the whole idea failed would hide its good slides.
        if (gen.slide_index === 0) await retryAnchorIfWorthwhile(supabase, gen);
      }
```

- [ ] **Step 3b: Add the anchor retry helper**

A failed middle slide costs one image; a failed anchor stalls the whole carousel. Below `fanOutCarousel`:

```ts
// Resubmits a failed anchor up to MAX_ANCHOR_ATTEMPTS. Attempts are counted
// from the slide-0 rows themselves rather than tracked in a column, so this
// stays stateless and survives concurrent ticks.
async function retryAnchorIfWorthwhile(
  supabase: SupabaseClient,
  failed: Generation,
): Promise<void> {
  const { data: anchorRows, error } = await supabase
    .from("generations")
    .select("status")
    .eq("idea_id", failed.idea_id)
    .eq("slide_index", 0);
  if (error) throw new Error(`anchor history query failed: ${error.message}`);
  const rows = anchorRows ?? [];
  const succeeded = rows.some((r) => r.status === "succeeded");
  if (!shouldRetryAnchor(rows.length, succeeded)) return;

  const apiKey = await getKieKeyOrNull(failed.user_id);
  if (!apiKey) return;

  const { data: ideaRow } = await supabase
    .from("ideas").select("*").eq("id", failed.idea_id).single();
  if (!ideaRow) return;
  const idea = ideaRow as Idea;
  const { data: catRow } = await supabase
    .from("categories").select("*")
    .eq("user_id", failed.user_id).eq("key", idea.category_key).single();
  if (!catRow) return;
  const category = catRow as Category;

  const slides = idea.slides ?? [];
  if (!slides.length) return;
  const prompt = buildSlidePrompt(
    category.style_guide, slides[0], 1, slides.length, false, failed.refinement_notes);
  const taskId = await createKieTask(
    apiKey, prompt, [failed.kie_style_url], category.aspect_ratio);
  await supabase.from("generations").insert({
    user_id: failed.user_id,
    idea_id: failed.idea_id,
    kie_task_id: taskId,
    status: "submitted",
    slide_index: 0,
    kie_style_url: failed.kie_style_url,
    full_prompt: prompt,
    refinement_notes: failed.refinement_notes,
  });
}
```

- [ ] **Step 4: Update imports**

Add to the top of the file: `shouldFanOut`, `slideIndexesToFanOut`, `isCarouselComplete`, `shouldRetryAnchor` from `@/lib/athena/fanout`; `buildSlidePrompt` from `@/lib/athena/image-prompt`; `createKieTask` from `@/lib/athena/kie`; and `Category`, `Idea` to the type import from `@/lib/types`.

- [ ] **Step 5: Verify the build**

Run: `npx tsc --noEmit && npm test`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Live check — requires migration 0008 applied**

Create one manual carousel via SQL, run the pipeline, and confirm the fan-out fires:

```sql
insert into ideas (user_id, category_key, concept, resolved_prompt, approved, status, batch_id, slides)
values (
  '4e380d19-990d-499e-9d4a-c3759b678d14', 'SAT_MYTH', 'fan-out smoke test', '',
  true, 'approved', gen_random_uuid(),
  '[{"role":"hook","text":"Test hook","visual":"A desk seen head on."},
    {"role":"beat","text":"Test beat","visual":"Overhead view of the same desk."},
    {"role":"payoff","text":"Test payoff","visual":"Close-up on the notebook."}]'::jsonb
);
```

Trigger generation from `/ideas`, then hit the poll endpoint until it settles. Expected: one generation at `slide_index = 0`, then two more at indexes 1 and 2 with `anchor_generation_id` set to the anchor's id, and the idea reaching `generated` only after all three succeed.

- [ ] **Step 7: Commit**

```bash
git add app/api/jobs/poll/route.ts
git commit -m "$(cat <<'EOF'
feat: fan out carousel slides once the anchor image exists

The poll cron gains phase two: on ingesting a slide-0 image it submits the
remaining slides against it, each recording anchor_generation_id. The guard
is keyed on the anchor so a re-anchor can fan out again rather than being
blocked forever by the previous run's slides.

An idea now reaches `generated` only when every slide has an image, and a
single failed slide no longer marks the whole idea failed — that would hide
its good slides from a composer that can still use them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Manual carousel authoring

Deliberately ahead of generated carousels: it exercises the whole slide pipeline with no LLM call, so Task 9 debugs prompt quality against a path already proven to work.

**Files:**
- Modify: `app/(app)/ideas/actions.ts`
- Create: `app/(app)/ideas/manual-idea-dialog.tsx`
- Modify: `app/(app)/ideas/page.tsx`

**Interfaces:**
- Consumes: `validateSlideShape` (Task 3), `Slide` (Task 2)
- Produces: `createManualIdea(input: { categoryKey: string; concept: string; slides: Slide[] }): Promise<void>`

- [ ] **Step 1: Add the server action**

Append to `app/(app)/ideas/actions.ts`:

```ts
// The manual counterpart to generated carousels: same table, same generation
// path, same composer — only the author differs. Slide count is NOT clamped
// to the category's images_per_carousel; a hand-authored carousel may be any
// length. It skips pending_review because that queue exists to review the
// model's writing, and there is nothing to review about text just typed.
export async function createManualIdea(input: {
  categoryKey: string;
  concept: string;
  slides: Slide[];
}): Promise<void> {
  const user = await requireUser();
  const supabase = await createServerSupabase();

  const shape = validateSlideShape(input.slides, input.slides.length);
  if (!shape.ok) throw new Error(shape.reason);
  if (!input.concept.trim()) throw new Error("concept is required");

  const { data: category } = await supabase
    .from("categories").select("key").eq("key", input.categoryKey).maybeSingle();
  if (!category) throw new Error(`unknown category ${input.categoryKey}`);

  const { error } = await supabase.from("ideas").insert({
    user_id: user.id,
    category_key: input.categoryKey,
    concept: input.concept,
    resolved_prompt: "",
    ai_filter_reason: "",
    approved: true,
    status: "approved",
    batch_id: randomUUID(),
    slides: input.slides,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/ideas");
}
```

Add imports at the top of the file: `import { randomUUID } from "crypto";`, `import { validateSlideShape } from "@/lib/athena/slides";`, `import type { Slide } from "@/lib/types";`.

Note `validateSlideShape(slides, slides.length)` — passing the array's own length checks role ordering while deliberately not constraining the count.

- [ ] **Step 2: Build the dialog**

Create `app/(app)/ideas/manual-idea-dialog.tsx`. Before writing it, open `app/(app)/config/category-manager.tsx` and match its conventions — that file is the reference for dialog structure, button styling, and toast usage in this codebase.

```tsx
"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createManualIdea } from "./actions";
import type { Category, Slide } from "@/lib/types";

const ROLES: Slide["role"][] = ["hook", "beat", "payoff", "single"];

// hook / beat... / payoff for a carousel, one `single` for a one-image post,
// so the common case needs no editing before saving.
function defaultSlides(count: number): Slide[] {
  if (count <= 1) return [{ role: "single", text: "", visual: "" }];
  return Array.from({ length: count }, (_, i) => ({
    role: i === 0 ? "hook" : i === count - 1 ? "payoff" : "beat",
    text: "",
    visual: "",
  }));
}

export function ManualIdeaDialog({ categories }: { categories: Category[] }) {
  const [open, setOpen] = useState(false);
  const [categoryKey, setCategoryKey] = useState(categories[0]?.key ?? "");
  const [concept, setConcept] = useState("");
  const [slides, setSlides] = useState<Slide[]>(
    defaultSlides(categories[0]?.images_per_carousel ?? 1),
  );
  const [busy, setBusy] = useState(false);

  function pickCategory(key: string) {
    setCategoryKey(key);
    const cat = categories.find((c) => c.key === key);
    setSlides(defaultSlides(cat?.images_per_carousel ?? 1));
  }

  function updateSlide(index: number, patch: Partial<Slide>) {
    setSlides((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function save() {
    setBusy(true);
    try {
      await createManualIdea({ categoryKey, concept, slides });
      toast.success("Idea created");
      setOpen(false);
      setConcept("");
      const cat = categories.find((c) => c.key === categoryKey);
      setSlides(defaultSlides(cat?.images_per_carousel ?? 1));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create idea");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="rounded-full">Add manually</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>New idea</DialogTitle></DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Category</Label>
            <select
              className="w-full rounded-md border bg-transparent px-3 py-2"
              value={categoryKey}
              onChange={(e) => pickCategory(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.key} value={c.key}>{c.key}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>Concept</Label>
            <Input
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              placeholder="One line summarising the story this tells"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Slides ({slides.length})</Label>
              <div className="flex gap-2">
                <Button
                  type="button" variant="outline" size="sm" className="rounded-full"
                  onClick={() =>
                    setSlides((p) => [...p, { role: "beat", text: "", visual: "" }])}
                >
                  Add slide
                </Button>
                <Button
                  type="button" variant="outline" size="sm" className="rounded-full"
                  disabled={slides.length <= 1}
                  onClick={() => setSlides((p) => p.slice(0, -1))}
                >
                  Remove last
                </Button>
              </div>
            </div>

            {slides.map((slide, i) => (
              <div key={i} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">{i + 1}</span>
                  <select
                    className="rounded-md border bg-transparent px-2 py-1 text-sm"
                    value={slide.role}
                    onChange={(e) =>
                      updateSlide(i, { role: e.target.value as Slide["role"] })}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <Input
                  value={slide.text}
                  onChange={(e) => updateSlide(i, { text: e.target.value })}
                  placeholder="Text on the panel"
                />
                <textarea
                  className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
                  rows={2}
                  value={slide.visual}
                  onChange={(e) => updateSlide(i, { visual: e.target.value })}
                  placeholder="Scene, camera angle, pose"
                />
              </div>
            ))}
          </div>

          <Button onClick={save} disabled={busy || !concept.trim()} className="rounded-full">
            {busy ? "Creating…" : "Create idea"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

If `@/components/ui/input` or `@/components/ui/button` differ from what this imports, match whatever `category-manager.tsx` actually uses rather than adding new components.

- [ ] **Step 3: Mount it**

In `app/(app)/ideas/page.tsx`, fetch categories alongside ideas:

```ts
  const { data: catData } = await supabase
    .from("categories").select("*").eq("active", true).order("key");
```

and render `<ManualIdeaDialog categories={(catData ?? []) as Category[]} />` next to the `<h1>`. Import `Category` from `@/lib/types`.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm test`
Then run the app, create a 3-slide carousel by hand, and confirm it lands on `/ideas` already approved with its slides visible in the database.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/ideas/actions.ts" "app/(app)/ideas/manual-idea-dialog.tsx" "app/(app)/ideas/page.tsx"
git commit -m "$(cat <<'EOF'
feat: hand-author a carousel with no LLM call

Closes a real gap: generateIdeas was the only path into `ideas`, so a
carousel could not be created without an LLM call at all. Slide count is not
clamped to the category default, so posts/create's count check must become
slide-aware in Phase B.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Generate structured carousels

**Files:**
- Modify: `lib/athena/prompts.ts`
- Modify: `lib/athena/generate-ideas.ts`
- Modify: `tests/prompts.test.ts`

**Interfaces:**
- Consumes: `validateSlideShape` (Task 3)
- Produces: `IdeasOutput` carrying `slides`; `buildIdeaSystemPrompt(brand, categories)` gains carousel instructions

- [ ] **Step 1: Write the failing tests**

Append to `tests/prompts.test.ts`:

```ts
describe("buildIdeaSystemPrompt — carousel instructions", () => {
  const brand = {
    business_name: "Athena", business_description: "SAT prep",
    audience: "parents", voice: "warm", avoid: "AI jargon",
  };
  const cats = [{ key: "SAT_MYTH", style_guide: "GUIDE", output_format: "", images_per_carousel: 5 }];

  it("states the required slide count per category", () => {
    expect(buildIdeaSystemPrompt(brand, cats)).toContain("5");
  });

  it("demands sequential dependency between beats", () => {
    expect(buildIdeaSystemPrompt(brand, cats).toLowerCase()).toContain("reorder");
  });

  it("demands structural variety across the batch", () => {
    expect(buildIdeaSystemPrompt(brand, cats).toLowerCase()).toContain("variety");
  });

  it("forbids panel labels in slide text", () => {
    expect(buildIdeaSystemPrompt(brand, cats).toLowerCase()).toContain("no panel numbers");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL on the new assertions (and on the changed `buildIdeaSystemPrompt` signature).

- [ ] **Step 3: Update the schema and prompt**

In `lib/athena/prompts.ts`, extend `IdeasOutput`:

```ts
export const IdeasOutput = z.object({
  ideas: z.array(z.object({
    category: z.string(),
    concept: z.string().describe("one-line summary of the story this carousel tells"),
    slides: z.array(z.object({
      role: z.enum(["hook", "beat", "payoff", "single"]),
      text: z.string().describe("the exact words appearing on this panel — short"),
      visual: z.string().describe("scene, camera angle, subject pose"),
    })),
  })),
});
```

Change `buildIdeaSystemPrompt`'s `categories` parameter type to include `images_per_carousel: number`, include each category's required slide count in the guides block, and append this section before the closing instructions.

Widening that parameter type breaks the existing call sites in `tests/prompts.test.ts` — **add `images_per_carousel` to the category fixtures in the six existing tests** rather than deleting or skipping them. They cover brand-block rendering and still earn their place.

```ts
    "CAROUSEL STRUCTURE — this is what you are writing:",
    "Each idea is a complete carousel with exactly the slide count listed for its category.",
    "When the count is greater than 1: exactly one 'hook' first, then 'beat' slides, then exactly one 'payoff' last.",
    "When the count is 1: a single slide with role 'single'.",
    "",
    "The panels must form ONE continuous story, not a set of separate observations:",
    "- Each beat must only make sense AFTER the one before it. If the panels could be reordered without loss, the carousel has failed.",
    "- The payoff must resolve the specific tension the hook opened — not a generic lesson.",
    "- 'text' is literally what appears on the image: one short phrase or sentence. No panel numbers, no labels, no captions about the panel.",
    "- 'visual' describes the scene, camera angle, and subject pose. Give every panel a different camera angle.",
    "- The story must be followable from the visuals alone.",
    "",
    "Across the batch, vary the STRUCTURE, not just the topic. Do not write every carousel to the same template or end every payoff with the same sentence shape — variety across the set matters as much as quality within one.",
```

- [ ] **Step 4: Validate shape before insert**

In `lib/athena/generate-ideas.ts`, pass `images_per_carousel` through to the prompt builder, carry `slides` alongside `concept` in the `raw` mapping, and drop malformed carousels before insert:

```ts
  const catByKey = new Map(cats.map((c) => [c.key, c]));
  const raw = generated.ideas
    .filter((i) => activeKeys.includes(i.category))
    .filter((i) => {
      const expected = catByKey.get(i.category)?.images_per_carousel ?? 1;
      const shape = validateSlideShape((i.slides ?? []) as Slide[], expected);
      if (!shape.ok) console.warn(`dropping malformed carousel (${i.category}): ${shape.reason}`);
      return shape.ok;
    })
    .map((i, idx) => ({
      idea_id: `idea_${idx}`, category: i.category, concept: i.concept,
      slides: i.slides as Slide[],
    }));
```

`applyFilterDecisions` spreads the whole idea object, so `slides` survives it untouched. Add `slides: i.slides` to the insert payload, and keep `resolved_prompt: i.concept` so legacy readers of that column don't break.

The count of dropped carousels is already reflected in the returned `filteredOut`, which is `merged.length - kept.length` — malformed ideas never enter `merged`, so add the drop count to it explicitly if the number matters for the UI.

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsc --noEmit && npm test`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Live check**

Generate a small batch (2–3 ideas) from `/generate` and confirm each idea row has a full `slides` array of the right shape, then that generation fans out as in Task 7.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/prompts.ts lib/athena/generate-ideas.ts tests/prompts.test.ts
git commit -m "$(cat <<'EOF'
feat: generate complete carousels instead of one-line concepts

One call now writes every slide, which is what makes the copy cohere —
chained image generation cannot fix text written without sight of the other
slides. Malformed carousels are dropped rather than repaired.

The prompt asks for structural variety across the batch: in testing all
three carousels collapsed into one template with three identically shaped
payoff lines, which is a prompt problem rather than an architectural one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Keep `/post` correct and unblocked

Two changes that keep existing behaviour honest now that ideas can carry several images.

**Files:**
- Modify: `lib/athena/carousel.ts` (`selectAutoFill`)
- Modify: `app/(app)/post/page.tsx` (the postables query)
- Modify: `tests/carousel.test.ts`

**Interfaces:**
- Consumes: `Postable` (existing, gains `slide_index` and `slide_count`)
- Produces: `selectAutoFill(postables: Postable[], n: number): Postable[]` — unchanged signature, changed selection

- [ ] **Step 1: Write the failing tests**

Append to `tests/carousel.test.ts`:

```ts
describe("selectAutoFill with multi-slide ideas", () => {
  const p = (id: string, ideaId: string, created: string, slideCount: number) => ({
    generation_id: id, idea_id: ideaId, idea_created_at: created,
    public_url: `u/${id}`, concept: "c", slide_index: 0, slide_count: slideCount,
  });

  it("skips slides belonging to a multi-slide carousel", () => {
    const pool = [
      p("a", "i1", "2026-01-01", 5),
      p("b", "i2", "2026-01-02", 1),
      p("c", "i3", "2026-01-03", 1),
    ];
    expect(selectAutoFill(pool, 2).map((x) => x.generation_id)).toEqual(["b", "c"]);
  });

  it("still fills from single-slide ideas oldest first", () => {
    const pool = [
      p("b", "i2", "2026-01-02", 1),
      p("c", "i3", "2026-01-03", 1),
      p("a", "i1", "2026-01-01", 1),
    ];
    expect(selectAutoFill(pool, 2).map((x) => x.generation_id)).toEqual(["a", "b"]);
  });

  it("returns nothing rather than a scrambled carousel", () => {
    expect(selectAutoFill([p("a", "i1", "2026-01-01", 5)], 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/carousel.test.ts`
Expected: FAIL — multi-slide entries are currently selected.

- [ ] **Step 3: Implement**

In `lib/athena/carousel.ts`, add `slide_index: number;` and `slide_count: number;` to `Postable`, and filter in `selectAutoFill`:

```ts
// Phase A: the default fill deliberately skips multi-slide carousels. All
// slides of one idea share an idea_created_at and nothing here sorts by
// slide_index, so including them would pre-fill a scrambled carousel —
// worse than not offering one. Phase B assembles them in order. The pool
// itself is unfiltered, so every image stays hand-pickable meanwhile.
export function selectAutoFill(postables: Postable[], n: number): Postable[] {
  return [...postables]
    .filter((p) => p.slide_count <= 1)
    .sort((a, b) => a.idea_created_at.localeCompare(b.idea_created_at))
    .slice(0, n);
}
```

- [ ] **Step 4: Ungate the pool**

In `app/(app)/post/page.tsx`, the postables query currently requires the idea to have reached `generated`. A carousel stuck at 4 of 5 would hide four perfectly good images, and freeform composition is the escape hatch from exactly that. Widen the idea-status filter to include `generating` as well as `generated`, keep the `generations.status = "succeeded"` filter as-is, and map `slide_index` plus the idea's `slides.length` into each `Postable`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsc --noEmit && npm test`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Verify by hand**

Open `/post` and confirm: the pre-filled selection contains no carousel slides; the swap-in pool still lists every succeeded image including carousel slides; and a five-image post of hand-picked images still posts to Buffer.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/carousel.ts "app/(app)/post/page.tsx" tests/carousel.test.ts
git commit -m "$(cat <<'EOF'
fix: keep /post honest now that one idea can yield several images

The default fill skips multi-slide carousels, because every slide of an idea
shares an idea_created_at and nothing sorted by slide_index — it would have
pre-filled a scrambled carousel. Phase B assembles them properly.

The pool is no longer gated on the idea reaching `generated`, so a carousel
stuck at 4 of 5 still offers its four good images. Every image remains
hand-pickable throughout.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase A Done When

- Migration `0008` applied; every legacy idea has exactly one slide.
- A hand-authored carousel generates end to end with no LLM call.
- A generated batch produces correctly shaped slide arrays.
- Slide 0 generates, the cron fans out the rest against it with `anchor_generation_id` set, and the idea reaches `generated` only when all slides succeed.
- A single failed slide leaves its siblings intact and the idea un-failed.
- `/post` still posts a hand-picked set of images, and its pool still lists every succeeded image.
- `npm test` and `npx tsc --noEmit` clean.

## Deferred to Phase B

Carousel fill in the composer (assembling slides in `slide_index` order); slide-aware count validation in `app/api/posts/create/route.ts`; `posts.idea_id` on creation; gallery grouping by carousel with per-slide retry vs. whole-carousel regenerate; the two-stage generating state in the gallery.
