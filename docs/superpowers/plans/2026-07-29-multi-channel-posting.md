# Multi-Channel Posting Implementation Plan (Post Menu, Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post one idea to many Buffer channels at once, each with copy adapted to its platform — multi-select chips, per-channel copy tabs, one media strip truncated per platform, best-effort fan-out recorded as N `posts` rows sharing a `post_group_id`, and grouped history.

**Architecture:** `posts/create` stops deriving a channel from the category and takes an explicit `channels[]`, validating once then posting sequentially and independently so one channel's failure never blocks the rest. Posted-slide memory gains a per-channel variant for the composer while the existing any-channel variant keeps driving the queue and completeness. The composer splits into an orchestrator plus a chip row and a copy-tabs component.

**Tech Stack:** Next.js App Router (nonstandard — see constraints), Supabase, Buffer GraphQL, `@anthropic-ai/sdk` + `zodOutputFormat`, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-multi-channel-posting-design.md`

## Global Constraints

- **Best-effort fan-out:** a channel's failure never stops the others, and the submission is never reported as wholly "posted" or "failed" when it was partial. A Buffer post cannot be un-posted — validation runs once BEFORE any Buffer call; after that, each channel stands alone.
- **All channels of one submission share one `post_group_id`.** A retry of failed channels reuses that same group id.
- **Per-channel vs any-channel memory:** the composer marks a slot posted only for the focused channel (`postedSlideIndexesByIdeaAndChannel`); the queue's `postedCount` and the completeness rule count a slide once it has gone to ANY channel (existing `postedSlideIndexesByIdea`, unchanged). Both read the same join rows.
- **`mediaForPlatform` feeds BOTH the preview and the outgoing Buffer payload** — what a platform's frame shows must be exactly what that platform receives. X truncates to 4.
- **Adaptation never overwrites hand edits:** a dirty tab is re-adapted only on an explicit click.
- BYOK: every Anthropic call uses `requireAnthropicKey(user.id)`; every Buffer call resolves its token via `getBufferTokenForConnection(user.id, connectionId)`.
- **This is NOT the Next.js you know** (AGENTS.md): mirror the existing route/page conventions; check `node_modules/next/dist/docs/` when unsure.
- Migration 0014 is a file only — applied to Supabase before the code deploys.
- Tests: `npx vitest run` (223 passing at plan time). Battery adds `npx tsc --noEmit`, `npm run build`, `npx eslint .` — the only expected finding is the pre-existing `scripts/import-athena-legacy.ts` unused-var warning.

---

### Task 1: Migration 0014, types, and `mediaForPlatform`

**Files:**
- Create: `supabase/migrations/0014_multi_channel_posts.sql`
- Modify: `lib/types.ts` (`Post` gains two fields)
- Modify: `lib/platform.ts` (add `mediaForPlatform`)
- Test: `tests/platform.test.ts` (extend)

**Interfaces:**
- Produces: `Post.adapted_from_caption: string`, `Post.buffer_channel_service: string`; `export function mediaForPlatform(imageUrls: string[], key: PlatformKey): string[]`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0014_multi_channel_posts.sql
-- Post Menu phase 3 (spec 2026-07-29-multi-channel-posting-design.md).
-- One submission fans out to N channels as N posts rows sharing the
-- post_group_id added in 0012. These two columns let history explain each
-- row on its own terms.

-- The base copy this channel's text was adapted from. Empty when the
-- channel posted the base copy unchanged.
alter table posts add column adapted_from_caption text not null default '';

-- The channel's service snapshotted at post time, so history renders the
-- right platform icon even after a category is re-pointed at another
-- channel (categories.buffer_channel_service is the CURRENT default, not
-- what this post actually went out on).
alter table posts add column buffer_channel_service text not null default '';
```

- [ ] **Step 2: Write the failing test**

Append to `tests/platform.test.ts`:

```ts
import { mediaForPlatform } from "@/lib/platform";

describe("mediaForPlatform", () => {
  const five = ["a", "b", "c", "d", "e"];
  it("truncates X to its 4-image mosaic limit", () => {
    expect(mediaForPlatform(five, "x")).toEqual(["a", "b", "c", "d"]);
  });
  it("passes every other platform through unchanged", () => {
    expect(mediaForPlatform(five, "tiktok")).toEqual(five);
    expect(mediaForPlatform(five, "instagram")).toEqual(five);
    expect(mediaForPlatform(five, "linkedin")).toEqual(five);
    expect(mediaForPlatform(five, "generic")).toEqual(five);
  });
  it("leaves short and empty lists alone on X", () => {
    expect(mediaForPlatform(["a", "b"], "x")).toEqual(["a", "b"]);
    expect(mediaForPlatform([], "x")).toEqual([]);
  });
  it("returns a new array rather than mutating its input", () => {
    const input = [...five];
    expect(mediaForPlatform(input, "x")).not.toBe(input);
    expect(input).toHaveLength(5);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/platform.test.ts`
Expected: FAIL — `mediaForPlatform` is not exported.

- [ ] **Step 4: Implement**

`lib/types.ts` — `Post` gains, after `scheduled_at`:
```ts
  adapted_from_caption: string;
  buffer_channel_service: string;
```

`lib/platform.ts` — append:
```ts
// X renders multiple images as a mosaic capped at four, not a carousel, so
// slides 5+ of a carousel would silently never appear. Truncating here —
// and using this for BOTH the preview and the outgoing payload — keeps the
// preview honest about what that platform actually receives.
const X_MAX_IMAGES = 4;

export function mediaForPlatform(imageUrls: string[], key: PlatformKey): string[] {
  return key === "x" ? imageUrls.slice(0, X_MAX_IMAGES) : [...imageUrls];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run` — all pass. Run: `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0014_multi_channel_posts.sql lib/types.ts lib/platform.ts tests/platform.test.ts
git commit -m "feat: per-channel post columns and platform media truncation"
```

---

### Task 2: Per-channel posted memory

**Files:**
- Modify: `lib/athena/carousel.ts` (`PostedSlideJoinRow` gains a channel field; add the per-channel variant)
- Test: `tests/carousel.test.ts` (extend)

**Interfaces:**
- Consumes: the existing `PostedSlideJoinRow` / `postedSlideIndexesByIdea`.
- Produces:
  ```ts
  export interface PostedSlideJoinRow {
    post_status: string;
    idea_id: string;
    slide_index: number;
    buffer_channel_id: string;   // NEW
  }
  export function postedSlideIndexesByIdeaAndChannel(
    rows: PostedSlideJoinRow[],
  ): Map<string, Map<string, Set<number>>>   // ideaId -> channelId -> slide indexes
  ```
  `postedSlideIndexesByIdea` keeps its exact current signature and behavior (any-channel semantics) — the queue and the completeness rule depend on it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/carousel.test.ts` (read the existing `postedSlideIndexesByIdea` tests first and reuse their row-fixture shape, adding `buffer_channel_id`):

```ts
import { postedSlideIndexesByIdeaAndChannel } from "@/lib/athena/carousel";

const postedRow = (
  idea_id: string, slide_index: number, buffer_channel_id: string, post_status = "queued",
) => ({ idea_id, slide_index, buffer_channel_id, post_status });

describe("postedSlideIndexesByIdeaAndChannel", () => {
  it("keeps each channel's posted slides separate", () => {
    const out = postedSlideIndexesByIdeaAndChannel([
      postedRow("i1", 0, "chan-a"),
      postedRow("i1", 1, "chan-a"),
      postedRow("i1", 0, "chan-b"),
    ]);
    expect([...out.get("i1")!.get("chan-a")!].sort()).toEqual([0, 1]);
    expect([...out.get("i1")!.get("chan-b")!]).toEqual([0]);
  });
  it("excludes failed posts", () => {
    const out = postedSlideIndexesByIdeaAndChannel([postedRow("i1", 0, "chan-a", "failed")]);
    expect(out.get("i1")).toBeUndefined();
  });
  it("separates ideas", () => {
    const out = postedSlideIndexesByIdeaAndChannel([
      postedRow("i1", 0, "chan-a"),
      postedRow("i2", 0, "chan-a"),
    ]);
    expect([...out.get("i1")!.get("chan-a")!]).toEqual([0]);
    expect([...out.get("i2")!.get("chan-a")!]).toEqual([0]);
  });
  it("returns an empty map for no rows", () => {
    expect(postedSlideIndexesByIdeaAndChannel([]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/carousel.test.ts`
Expected: FAIL — `postedSlideIndexesByIdeaAndChannel` is not exported.

- [ ] **Step 3: Implement**

In `lib/athena/carousel.ts`, add `buffer_channel_id: string;` to `PostedSlideJoinRow`, then append:

```ts
// The composer's variant: a slide is "already posted" only for the channel
// it actually went to, so a carousel sent to LinkedIn today is still fresh
// for X next week. The any-channel variant above stays the queue's and the
// completeness rule's view — those answer "is there work left", not "where
// has this been".
export function postedSlideIndexesByIdeaAndChannel(
  rows: PostedSlideJoinRow[],
): Map<string, Map<string, Set<number>>> {
  const byIdea = new Map<string, Map<string, Set<number>>>();
  for (const row of rows) {
    if (row.post_status === "failed") continue;
    const byChannel = byIdea.get(row.idea_id) ?? new Map<string, Set<number>>();
    const slides = byChannel.get(row.buffer_channel_id) ?? new Set<number>();
    slides.add(row.slide_index);
    byChannel.set(row.buffer_channel_id, slides);
    byIdea.set(row.idea_id, byChannel);
  }
  return byIdea;
}
```

Then update the three existing callers' SELECTs so the joined rows carry `buffer_channel_id` — `app/api/posts/create/route.ts`, `app/(app)/post/[ideaId]/page.tsx`, `app/(app)/post/page.tsx`. Each already selects `post:posts(status)` or similar; extend that embedded select to include `buffer_channel_id` and map it into the join-row shape. Do NOT change what those three currently DO with the result in this task — Task 5 switches the composer to the per-channel variant.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run` — all pass (existing `postedSlideIndexesByIdea` tests unchanged). Run: `npx tsc --noEmit` — clean. Run: `npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/carousel.ts tests/carousel.test.ts app/api/posts/create/route.ts "app/(app)/post/[ideaId]/page.tsx" "app/(app)/post/page.tsx"
git commit -m "feat: per-channel posted-slide memory"
```

---

### Task 3: The adaptation endpoint

**Files:**
- Create: `app/api/posts/adapt-caption/route.ts`
- Modify: `lib/athena/prompts.ts` (add the adaptation prompt builder)
- Test: `tests/prompts.test.ts` (extend)

**Interfaces:**
- Consumes: `brandBlock`, `platformPresetFor`, `BrandContext` (existing, `lib/athena/prompts.ts`); `requireAnthropicKey`; `createServerSupabase`; the route conventions in `app/api/posts/rewrite-caption/route.ts`.
- Produces:
  - `export function buildAdaptCaptionSystemPrompt(brand: BrandContext, category: Pick<Category, "caption_guide">, service: string): string`
  - `POST /api/posts/adapt-caption` — `{ categoryKey: string, ideaId?: string, baseText: string, service: string }` → `{ text: string }`; 401 / 400 / 404 / 500 with message passthrough.

- [ ] **Step 1: Write the failing test**

Append to `tests/prompts.test.ts`:

```ts
import { buildAdaptCaptionSystemPrompt } from "@/lib/athena/prompts";

describe("buildAdaptCaptionSystemPrompt", () => {
  const brand = {
    business_name: "Athena", business_description: "SAT prep",
    audience: "parents", voice: "warm", avoid: "AI jargon",
  };
  it("carries the target platform's conventions", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "" }, "x");
    expect(p).toContain("280");
  });
  it("layers the category's copy guide over the platform preset", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "Always end with a question." }, "linkedin");
    const preset = p.indexOf("thought leadership");
    const guide = p.indexOf("Always end with a question.");
    expect(preset).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(preset);
  });
  it("injects the brand context", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "" }, "linkedin");
    expect(p).toContain("Athena");
    expect(p).toContain("parents");
  });
  it("instructs preserving the point rather than restating verbatim", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "" }, "x");
    expect(p.toLowerCase()).toContain("same point");
  });
  it("omits the guide section entirely when the category has none", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "" }, "x");
    expect(p).not.toContain("COPY GUIDE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL — `buildAdaptCaptionSystemPrompt` is not exported.

- [ ] **Step 3: Implement the prompt builder**

In `lib/athena/prompts.ts`:

```ts
export function buildAdaptCaptionSystemPrompt(
  brand: BrandContext,
  category: Pick<Category, "caption_guide">,
  service: string,
): string {
  return [
    "You adapt one social post's copy for a different platform. Return only the adapted copy.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    `TARGET PLATFORM: ${platformPresetFor(service)}`,
    category.caption_guide.trim() ? `COPY GUIDE (wins over the platform note where they conflict):\n${category.caption_guide}` : "",
    "",
    "Make the same point the original makes — this is the same post going to another audience, not a new idea. Restructure freely for the target platform's conventions: its length, its hook style, its formatting. Never simply copy the original across.",
  ].filter(Boolean).join("\n");
}
```

(`Category` is already imported in this file for `buildIdeaSystemPrompt`'s parameter typing; if not, add `import type { Category } from "@/lib/types";`.)

- [ ] **Step 4: Write the route**

`app/api/posts/adapt-caption/route.ts` — mirror `app/api/posts/rewrite-caption/route.ts` closely (auth → body validation → RLS loads → LLM → error mapping):

```ts
import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { buildAdaptCaptionSystemPrompt, type BrandContext } from "@/lib/athena/prompts";
import type { Category, Idea } from "@/lib/types";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const AdaptOutput = z.object({ text: z.string().describe("the adapted post copy, nothing else") });

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryKey = body?.categoryKey;
  const baseText = body?.baseText;
  const service = body?.service;
  const ideaId = typeof body?.ideaId === "string" && body.ideaId ? body.ideaId : null;
  if (typeof categoryKey !== "string" || typeof baseText !== "string" || !baseText.trim() ||
      typeof service !== "string") {
    return NextResponse.json(
      { error: "expected { categoryKey: string, baseText: string, service: string, ideaId?: string }" },
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

    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id) });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system: buildAdaptCaptionSystemPrompt(brand, category, service),
      messages: [{
        role: "user",
        content: [
          idea?.slides?.length
            ? `THE POST'S SLIDES (context — do not repeat their text verbatim):\n${JSON.stringify(idea.slides)}\n\n`
            : "",
          `ORIGINAL COPY:\n${baseText}`,
        ].join(""),
      }],
      output_config: { format: zodOutputFormat(AdaptOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) throw new Error(`adaptation returned no parseable output (stop_reason: ${response.stop_reason})`);
    return NextResponse.json({ text: parsed.text });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("caption adaptation failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 5: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean (route registered).

- [ ] **Step 6: Commit**

```bash
git add lib/athena/prompts.ts app/api/posts/adapt-caption/route.ts tests/prompts.test.ts
git commit -m "feat: per-platform caption adaptation endpoint"
```

---

### Task 4: Fan-out in `posts/create`

**Files:**
- Create: `lib/athena/fan-out.ts` (pure result shaping)
- Modify: `app/api/posts/create/route.ts`
- Test: `tests/fan-out.test.ts`

**Interfaces:**
- Consumes: `getBufferTokenForConnection` (`lib/settings/buffer.ts`), `postToBuffer` (`lib/athena/buffer.ts`), `mediaForPlatform` + `normalizeService` (Task 1 / `lib/platform.ts`), `postedSlideIndexesByIdea` (existing, any-channel — completeness).
- Produces:
  ```ts
  // lib/athena/fan-out.ts
  export interface ChannelResult {
    channelId: string;
    status: "queued" | "failed";
    bufferUpdateId?: string;
    error?: string;
  }
  export function summarizeFanOut(results: ChannelResult[]): {
    queued: number; failed: number; allFailed: boolean; label: string;
  }
  ```
  `label` reads e.g. `"2 queued · 1 failed"`, `"3 queued"`, `"1 failed"`.
  Route request: `{ category_key, generation_ids, channels: [{connectionId, channelId, service, caption}], scheduled_at?, post_group_id? }`; response `{ postGroupId, results: ChannelResult[] }`. `post_group_id` is supplied only by a retry, to reuse the original group.

- [ ] **Step 1: Write the failing test**

`tests/fan-out.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { summarizeFanOut, type ChannelResult } from "@/lib/athena/fan-out";

const ok = (channelId: string): ChannelResult => ({ channelId, status: "queued", bufferUpdateId: "u1" });
const bad = (channelId: string): ChannelResult => ({ channelId, status: "failed", error: "nope" });

describe("summarizeFanOut", () => {
  it("summarizes a mixed run", () => {
    const s = summarizeFanOut([ok("a"), ok("b"), bad("c")]);
    expect(s).toMatchObject({ queued: 2, failed: 1, allFailed: false });
    expect(s.label).toBe("2 queued · 1 failed");
  });
  it("summarizes an all-success run", () => {
    const s = summarizeFanOut([ok("a"), ok("b"), ok("c")]);
    expect(s).toMatchObject({ queued: 3, failed: 0, allFailed: false });
    expect(s.label).toBe("3 queued");
  });
  it("flags an all-failed run", () => {
    const s = summarizeFanOut([bad("a"), bad("b")]);
    expect(s).toMatchObject({ queued: 0, failed: 2, allFailed: true });
    expect(s.label).toBe("2 failed");
  });
  it("handles an empty result list without claiming everything failed", () => {
    const s = summarizeFanOut([]);
    expect(s).toMatchObject({ queued: 0, failed: 0, allFailed: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fan-out.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement the helper**

`lib/athena/fan-out.ts`:

```ts
export interface ChannelResult {
  channelId: string;
  status: "queued" | "failed";
  bufferUpdateId?: string;
  error?: string;
}

// A multi-channel submission is never wholly "posted" or "failed" when it
// was partial — a Buffer post cannot be un-posted, so the summary has to
// say exactly what happened.
export function summarizeFanOut(results: ChannelResult[]): {
  queued: number; failed: number; allFailed: boolean; label: string;
} {
  const queued = results.filter((r) => r.status === "queued").length;
  const failed = results.length - queued;
  const parts: string[] = [];
  if (queued) parts.push(`${queued} queued`);
  if (failed) parts.push(`${failed} failed`);
  return {
    queued, failed,
    allFailed: results.length > 0 && queued === 0,
    label: parts.join(" · "),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fan-out.test.ts` — PASS.

- [ ] **Step 5: Rework the route**

In `app/api/posts/create/route.ts`:

- **Body:** replace the category-derived channel with a required `channels` array. Validate: non-empty; every entry has string `connectionId`, `channelId`, `service`, `caption`; `channelId`s unique. Reject an empty array with 400 ("select at least one channel"). Keep every existing validation (auth, generation ownership, the anchor check via `findWrongAnchorGenerationIds`, slide rules, past-date rejection) — and keep it all BEFORE any Buffer call.
- **Group id:** `const postGroupId = typeof body?.post_group_id === "string" && body.post_group_id ? body.post_group_id : randomUUID();` (import `randomUUID` from `crypto`, as `lib/athena/generate-ideas.ts` does).
- **Fan out** sequentially:
```ts
  const results: ChannelResult[] = [];
  for (const ch of channels) {
    const urls = mediaForPlatform(imageUrls, normalizeService(ch.service));
    let r;
    try {
      const token = await getBufferTokenForConnection(user.id, ch.connectionId);
      r = await postToBuffer(token, ch.channelId, urls, ch.caption, scheduledAt ?? undefined);
    } catch (e) {
      r = { success: false, postId: "", error: e instanceof Error ? e.message : String(e), rawBody: "" };
    }
    // one posts row per channel, sharing postGroupId
    const { data: postRow, error: postErr } = await supabase.from("posts").insert({
      user_id: user.id,
      category_key: categoryKey,
      post_group_id: postGroupId,
      buffer_update_id: r.success ? r.postId : "",
      buffer_channel_id: ch.channelId,
      buffer_channel_service: ch.service,
      caption: ch.caption,
      adapted_from_caption: ch.caption === baseCaption ? "" : baseCaption,
      status: r.success ? "queued" : "failed",
      error: r.success ? "" : (r.error || r.rawBody.slice(0, 2000)),
      idea_id: singleIdeaId,
      scheduled_at: scheduledAt,
    }).select().single();
    if (postErr || !postRow) {
      results.push({ channelId: ch.channelId, status: "failed", error: `posted but failed to record: ${postErr?.message}` });
      continue;
    }
    if (r.success) {
      await supabase.from("post_images").insert(
        ordered.map((g, idx) => ({ user_id: user.id, post_id: postRow.id, generation_id: g.id, sort_order: idx })),
      );
    }
    results.push(r.success
      ? { channelId: ch.channelId, status: "queued", bufferUpdateId: r.postId }
      : { channelId: ch.channelId, status: "failed", error: r.error || r.rawBody.slice(0, 500) });
  }
```
  `baseCaption` is `body?.caption` when supplied (the composer sends its Base tab text alongside `channels`) — accept it as an optional string defaulting to `""`; a channel whose caption equals it stores `adapted_from_caption: ""`.
  Note `post_images` rows are inserted only for channels that actually posted, so per-channel memory (Task 2) reflects reality.
- **Completeness:** after the loop, run the existing rule over the union of previously-posted slide indexes and this submission's — but only when at least one channel queued. Unchanged semantics otherwise (any-channel).
- **Response:** `NextResponse.json({ postGroupId, results })` with status 200 when anything queued, 500 when `summarizeFanOut(results).allFailed`.

- [ ] **Step 6: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean (the composer still sends the old body shape and WILL fail to typecheck if it references removed fields; if so, leave the composer's call site minimally adjusted to send a single-element `channels` array so the branch builds — Task 5 replaces it properly). `npm run build` — clean.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/fan-out.ts tests/fan-out.test.ts app/api/posts/create/route.ts "app/(app)/post/[ideaId]/composer.tsx"
git commit -m "feat: best-effort multi-channel fan-out in posts/create"
```

---

### Task 5: Composer — chip row, copy tabs, adaptation

The composer is 456 lines before this task; chips + tabs + adaptation would push it past 700, so it splits into an orchestrator plus two components.

**Files:**
- Create: `app/(app)/post/[ideaId]/channel-chips.tsx`
- Create: `app/(app)/post/[ideaId]/copy-tabs.tsx`
- Modify: `app/(app)/post/[ideaId]/composer.tsx` (orchestrator)
- Modify: `app/(app)/post/[ideaId]/page.tsx` (pass all channel groups + per-channel posted memory)

**Interfaces:**
- Consumes: `ChannelGroup` (`lib/settings/buffer.ts`), `postedSlideIndexesByIdeaAndChannel` (Task 2), `mediaForPlatform`/`normalizeService`/`platformCharLimit` (Task 1), `PlatformPreview`, `POST /api/posts/adapt-caption` (Task 3), `POST /api/posts/create`'s new body (Task 4), `summarizeFanOut` (Task 4).
- Produces:
  ```ts
  export interface SelectedChannel {
    connectionId: string; channelId: string; service: string;
    label: string;        // display name
    caption: string;
    dirty: boolean;       // hand-edited: never auto-re-adapt
    adapting: boolean;
    status?: "queued" | "failed";
    error?: string;
  }
  export function ChannelChips(props: {
    groups: ChannelGroup[];
    selected: SelectedChannel[];
    onAdd(ch: { connectionId: string; channelId: string; service: string; label: string }): void;
    onRemove(channelId: string): void;
    focusedChannelId: string | null;
    onFocus(channelId: string | null): void;
  }): JSX.Element
  export function CopyTabs(props: {
    baseCaption: string;
    onBaseChange(text: string): void;
    selected: SelectedChannel[];
    focusedChannelId: string | null;
    onFocus(channelId: string | null): void;
    onChannelCaptionChange(channelId: string, text: string): void;
    onReadapt(channelId: string): void;
    truncatedNoteFor(channelId: string): string;
  }): JSX.Element
  ```

- [ ] **Step 1: Widen the server page**

`app/(app)/post/[ideaId]/page.tsx`: it currently fetches only the category's own connection's channels. Fetch ALL connections' channels (reuse the pattern in `app/(app)/config/page.tsx`: `listBufferConnections` then `getBufferChannelsForConnection` per connection inside try/catch, producing `ChannelGroup[]`), and pass `groups` down. Also switch its posted-memory computation to `postedSlideIndexesByIdeaAndChannel` and pass a serializable `postedByChannel: Record<string, number[]>` (channelId → slide indexes) for THIS idea. Keep the existing `channelMissing` logic for the category's default channel — it still drives the "pick this category's channel in Config" warning.

- [ ] **Step 2: Build `ChannelChips`**

A row of chips for `selected` (each: service icon via lucide, label, a status dot when `status` is set, an × to remove, and click-to-focus that highlights the focused one), plus an "+ Add channel" control opening a menu of every channel in `groups` grouped by connection label, with already-selected ones disabled. Removing a chip whose `dirty` is true confirms first ("This channel's copy was edited — remove it?"). Follow the repo's client idioms (shadcn `Button`, Tailwind), and mirror `app/(app)/config/category-manager.tsx`'s optgroup grouping for the menu.

- [ ] **Step 3: Build `CopyTabs`**

A tab strip: **Base** plus one tab per selected channel (service icon + label; a dot when `dirty`; a spinner when `adapting`). The focused tab renders a `Textarea` bound to that tab's text, a character counter when `platformCharLimit(normalizeService(service))` is non-null (destructive past the limit, non-blocking), the truncation note from `truncatedNoteFor(channelId)` when non-empty, and — for channel tabs — a "Re-adapt from base" button that confirms when `dirty`. Editing a channel tab sets `dirty` via `onChannelCaptionChange`. Keep the existing rewrite-with-notes control in the orchestrator, applying to the focused tab.

- [ ] **Step 4: Rework the orchestrator**

In `composer.tsx`:
- State: `baseCaption` (initialized as today from `idea.post_text.trim() || pickCaption(category.post_caption)`), `selected: SelectedChannel[]` (initialized with the category's default channel when present and not `channelMissing`, `caption: baseCaption`, `dirty: false`), `focusedChannelId` (null = Base tab).
- **Auto-adapt on add:** `onAdd` appends the channel with `caption: baseCaption, dirty: false, adapting: true`, then calls `/api/posts/adapt-caption` with `{categoryKey: category.key, ideaId: idea.id, baseText: baseCaption, service}`; on success set its `caption` and `adapting: false` **only if the tab is still not dirty** (the user may have typed meanwhile); on failure set `adapting: false` and surface an inline error on that tab.
- **Re-adapt** runs the same call for one channel, allowed on a dirty tab only after its confirm.
- **Posted slots are per-channel:** the media strip's already-posted marking reads `postedByChannel[focusedChannelId]` (Base tab → the union across channels, so the Base view still shows what's gone out somewhere).
- **Preview** uses the focused tab's caption and `mediaForPlatform(currentSlotUrls, normalizeService(focusedService))`; the Base tab previews with the category's own service.
- **`truncatedNoteFor(channelId)`** returns e.g. `"X carries 4 images — the last 1 won't be sent."` when `mediaForPlatform` shortens the current slot list for that channel, else `""`.
- **Posting:** send `{category_key, generation_ids, caption: baseCaption, channels: selected.map(...), scheduled_at?}`. On response, write each result's `status`/`error` onto its chip, show `summarizeFanOut(results).label`, and — when any failed — offer "Retry failed channels", which re-submits only those channels together with the returned `postGroupId`. Navigate back to `/post` only when nothing failed.
- Posting is disabled when `selected.length === 0`.

- [ ] **Step 5: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean. `npx eslint .` — only the pre-existing `import-athena-legacy` warning.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/post/[ideaId]"
git commit -m "feat: multi-channel chips and per-platform copy tabs in the composer"
```

---

### Task 6: Grouped history

**Files:**
- Create: `lib/athena/post-groups.ts`
- Modify: `app/(app)/post/page.tsx` (recent-posts section)
- Test: `tests/post-groups.test.ts`

**Interfaces:**
- Consumes: `summarizeFanOut`-style counting (implement independently here — these are DB rows, not fan-out results).
- Produces:
  ```ts
  export interface PostGroupRow {
    postGroupId: string;
    categoryKey: string;
    createdAt: string;
    scheduledAt: string | null;
    channels: {
      postId: string; channelId: string; service: string;
      status: string; error: string; caption: string;
    }[];
    queued: number; failed: number; label: string;
  }
  export function groupPosts(
    posts: { id: string; post_group_id: string; category_key: string; created_at: string;
             scheduled_at: string | null; buffer_channel_id: string; buffer_channel_service: string;
             status: string; error: string; caption: string }[],
  ): PostGroupRow[]
  ```
  Newest group first (by the group's newest `created_at`).

- [ ] **Step 1: Write the failing test**

`tests/post-groups.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupPosts } from "@/lib/athena/post-groups";

const row = (
  id: string, group: string, status: string, created_at: string,
  buffer_channel_id = `chan-${id}`, buffer_channel_service = "linkedin",
) => ({
  id, post_group_id: group, category_key: "CAT", created_at, scheduled_at: null,
  buffer_channel_id, buffer_channel_service, status, error: status === "failed" ? "nope" : "",
  caption: `copy ${id}`,
});

describe("groupPosts", () => {
  it("groups channels of one submission and summarizes them", () => {
    const groups = groupPosts([
      row("a", "g1", "queued", "2026-01-01"),
      row("b", "g1", "queued", "2026-01-01"),
      row("c", "g1", "failed", "2026-01-01"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].channels).toHaveLength(3);
    expect(groups[0]).toMatchObject({ queued: 2, failed: 1 });
    expect(groups[0].label).toBe("2 queued · 1 failed");
  });
  it("renders a single-channel post as a group of one", () => {
    const groups = groupPosts([row("a", "g1", "queued", "2026-01-01")]);
    expect(groups[0].channels).toHaveLength(1);
    expect(groups[0].label).toBe("1 queued");
  });
  it("orders newest group first", () => {
    const groups = groupPosts([
      row("old", "g1", "queued", "2026-01-01"),
      row("new", "g2", "queued", "2026-02-01"),
    ]);
    expect(groups.map((g) => g.postGroupId)).toEqual(["g2", "g1"]);
  });
  it("returns nothing for no rows", () => {
    expect(groupPosts([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/post-groups.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

`lib/athena/post-groups.ts` — group by `post_group_id`, collect channels in insertion order, count `status === "queued"` vs everything else as failed, build the same `"N queued · M failed"` label shape (omit a zero side), take the group's `categoryKey`/`scheduledAt` from its first row and `createdAt` as the newest in the group, and sort groups by `createdAt` descending.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/post-groups.test.ts` — PASS.

- [ ] **Step 5: Render grouped history**

In `app/(app)/post/page.tsx`'s recent-posts section: extend the posts SELECT to include `post_group_id`, `buffer_channel_service`, `error`, `caption`, `scheduled_at`; call `groupPosts`; render one row per group — category badge, channel count, the status label, and the scheduled time when set — expanding (a `<details>` or a small client toggle, matching the repo's idioms) to per-channel rows showing service icon, channel, status, error when failed, and the caption that channel actually posted.

- [ ] **Step 6: Full battery**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean. `npx eslint .` — only the pre-existing `import-athena-legacy` warning.

- [ ] **Step 7: Commit**

```bash
git add lib/athena/post-groups.ts tests/post-groups.test.ts "app/(app)/post/page.tsx"
git commit -m "feat: group multi-channel posts in history"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §2 → Task 1; §3 → Task 2 (+ consumed in Task 5); §4 → Task 5 (chips) with the server page widened in Task 5 Step 1; §5 → Tasks 3 and 5; §6 → Task 1 (`mediaForPlatform`) + Task 4 (payload) + Task 5 (preview and note); §7 → Task 4; §8 → Task 6; §9 error handling → Tasks 3-5 (inline errors, disabled-when-empty, partial reporting); §10 testing → Tasks 1-4, 6 (§10's items each map to a test block; the composer is UI-only per the repo's convention); §11 out-of-scope has no tasks.
- **Type consistency:** `ChannelResult`/`summarizeFanOut`/`SelectedChannel`/`ChannelChips`/`CopyTabs`/`mediaForPlatform`/`postedSlideIndexesByIdeaAndChannel`/`groupPosts`/`PostGroupRow` names match across tasks; `PostedSlideJoinRow` gains `buffer_channel_id` in Task 2 and all three of its callers are updated there.
- **Ordering note:** Task 4 changes `posts/create`'s contract before Task 5 updates the composer properly — Task 4 Step 6 says to keep the branch building with a minimal single-element `channels` array at the call site, so no task leaves the tree broken.
- **Deploy order:** migration 0014 before the code deploy (the new columns are written on every post).
- **Not CI-verifiable:** the fan-out against real Buffer and the adaptation quality. After Task 6, the human should post one idea to two channels (one being X, to see truncation), confirm both land in Buffer, and check history groups them.
