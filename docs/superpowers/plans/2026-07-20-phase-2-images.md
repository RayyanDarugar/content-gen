# Athena Content App — Phase 2 Implementation Plan (Images + Gallery)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approved ideas become images via Kie.ai, polled by an external cron hitting a bounded ingest endpoint, stored as JPEG in Supabase Storage, and managed in a live-updating gallery with retry and regenerate-with-notes.

**Architecture:** Stateless replacement for n8n Workflow B's wait-loop: a `POST /api/images/generate` route submits Kie tasks and records them in `generations`; a `GET /api/jobs/poll` route (cron-job.org, every 60s, bearer `CRON_SECRET`) advances all pending rows per tick — cheap status checks unbounded, heavy ingestion (download → sharp JPEG q90 → Storage upload) capped at 5/tick. Gallery is a server component refreshed by a Supabase Realtime subscription.

**Tech Stack:** Existing Phase 1 stack + `sharp`. Kie.ai endpoints/shapes are pinned in the Phase 2 spec §3.

**Spec:** `docs/superpowers/specs/2026-07-20-phase-2-images-design.md` (and parent spec for anything not covered here)

## Global Constraints

- All Phase 1 global constraints still apply (secrets server-side only; `requireAllowedUser()` on every user-facing mutating route/action; TypeScript strict).
- `/api/jobs/poll` is authenticated by `Authorization: Bearer ${CRON_SECRET}` with a **constant-time comparison** — never `requireAllowedUser()` (no session on cron requests). It must fail closed (401) when `CRON_SECRET` is unset.
- Kie auth: `Authorization: Bearer ${process.env.KIE_API_KEY}` on all three Kie endpoints.
- Poll cap: exactly **20** polls per generation attempt (n8n parity). Successful-but-not-yet-ingested rows must NOT consume poll counts.
- Ingestion cap: **5** full ingests per poll tick.
- Image storage: bucket `images`, path `{generation_id}.jpg`, JPEG quality **90**, `upsert: true` (idempotent double-fire).
- Prompt composition must exactly match `buildImagePrompt` in Task 3 (verbatim n8n port; refinement notes appended to the content section only).
- Generation status values: `submitted → polling → succeeded | failed` (existing schema CHECK). Idea transitions: submit → `generating`; success → `generated`; failure → `failed`.
- Never modify `n8n-files/` or Phase 1 files except where a task explicitly says Modify.
- Commit after every task.

---

### Task 1: Migration 0003 (refinement notes, images bucket, realtime)

**Files:**
- Create: `supabase/migrations/0003_phase2_images.sql`

**Interfaces:**
- Consumes: existing schema from 0001/0002.
- Produces: `generations.refinement_notes` column; public `images` storage bucket; `generations` in the realtime publication.

**⚠️ USER CHECKPOINT:** the human applies this in the Supabase SQL editor (same as 0001/0002) before Tasks 6+ can be live-verified.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0003_phase2_images.sql`:

```sql
-- Phase 2: image generation support.

alter table generations add column refinement_notes text not null default '';

-- Public bucket for generated images. Public read is intentional (Buffer needs
-- fetchable URLs in Phase 3); writes go through the service-role client only.
insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do nothing;

-- Live gallery updates.
alter publication supabase_realtime add table generations;
```

- [ ] **Step 2: USER — apply via Supabase SQL editor**

Paste and run. Expected: "Success. No rows returned."

- [ ] **Step 3: Verify from the repo**

```bash
cd "/Users/rayyandarugar/Coding Projects/content-gen-app" && set -a; source .env.local; set +a
curl -s "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/generations?select=refinement_notes&limit=1" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
curl -s "${NEXT_PUBLIC_SUPABASE_URL}/storage/v1/bucket/images" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

Expected: first returns `[]` (column exists, no rows — a missing column would error); second returns bucket JSON with `"public": true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/ && git commit -m "feat: phase 2 migration (refinement notes, images bucket, realtime)"
```

---

### Task 2: Dependencies, types, CRON_SECRET

**Files:**
- Modify: `package.json` (+ lockfile) — add `sharp`
- Modify: `lib/types.ts` — add `refinement_notes` to `Generation`
- Modify: `.env.local` — set `CRON_SECRET` (gitignored; generate, don't ask the user)

**Interfaces:**
- Consumes: existing `Generation` interface.
- Produces: `Generation.refinement_notes: string`; `sharp` installed; `CRON_SECRET` set locally.

- [ ] **Step 1: Install sharp**

```bash
npm install sharp
```

- [ ] **Step 2: Add the field to `lib/types.ts`**

In `interface Generation`, after `full_prompt: string;` add:

```ts
  refinement_notes: string;
```

- [ ] **Step 3: Generate CRON_SECRET into `.env.local`**

```bash
cd "/Users/rayyandarugar/Coding Projects/content-gen-app"
SECRET=$(openssl rand -hex 32)
sed -i '' "s/^CRON_SECRET=$/CRON_SECRET=${SECRET}/" .env.local
grep -c '^CRON_SECRET=.\{64\}$' .env.local
```

Expected: final grep prints `1`. Never print the secret itself.

- [ ] **Step 4: Build + commit**

```bash
npm run build
git add package.json package-lock.json lib/types.ts && git commit -m "feat: add sharp, refinement_notes type, local cron secret"
```

---

### Task 3: Image prompt builder (TDD)

**Files:**
- Create: `lib/athena/image-prompt.ts`
- Test: `tests/image-prompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildImagePrompt(styleGuide: string, resolvedPrompt: string, refinementNotes?: string): string` — used verbatim by Task 6.

- [ ] **Step 1: Write the failing test**

`tests/image-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildImagePrompt } from "@/lib/athena/image-prompt";

const SUFFIX =
  "\n\nReference the provided style image to maintain visual consistency in palette, illustration style, and layout.";

describe("buildImagePrompt", () => {
  it("composes style guide + content + consistency suffix (n8n parity)", () => {
    expect(buildImagePrompt("GUIDE", "CONTENT")).toBe(
      "GUIDE\n\nSPECIFIC CONTENT FOR THIS IMAGE:\nCONTENT" + SUFFIX,
    );
  });
  it("appends refinement notes inside the content section", () => {
    expect(buildImagePrompt("GUIDE", "CONTENT", "make the dog bigger")).toBe(
      "GUIDE\n\nSPECIFIC CONTENT FOR THIS IMAGE:\nCONTENT\n\nRefinement notes: make the dog bigger" + SUFFIX,
    );
  });
  it("treats empty notes as absent", () => {
    expect(buildImagePrompt("G", "C", "")).toBe(buildImagePrompt("G", "C"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test` — Expected: FAIL, cannot resolve `@/lib/athena/image-prompt`.

- [ ] **Step 3: Implement**

`lib/athena/image-prompt.ts`:

```ts
export function buildImagePrompt(
  styleGuide: string,
  resolvedPrompt: string,
  refinementNotes = "",
): string {
  const content = refinementNotes
    ? `${resolvedPrompt}\n\nRefinement notes: ${refinementNotes}`
    : resolvedPrompt;
  return (
    styleGuide +
    "\n\nSPECIFIC CONTENT FOR THIS IMAGE:\n" +
    content +
    "\n\nReference the provided style image to maintain visual consistency in palette, illustration style, and layout."
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npm test`, all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/image-prompt.ts tests/image-prompt.test.ts && git commit -m "feat: image prompt builder (n8n workflow B parity)"
```

---

### Task 4: Poll decision logic (TDD)

**Files:**
- Create: `lib/athena/poll-logic.ts`
- Test: `tests/poll-logic.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used verbatim by Task 7):
  - `POLL_CAP = 20`
  - `interface KieRecord { state: string; resultUrl: string | null }`
  - `type PollDecision = { action: "ingest"; resultUrl: string } | { action: "fail"; error: string } | { action: "wait"; pollCount: number }`
  - `decidePoll(record: KieRecord, currentPollCount: number): PollDecision`

- [ ] **Step 1: Write the failing tests**

`tests/poll-logic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decidePoll, POLL_CAP } from "@/lib/athena/poll-logic";

describe("decidePoll", () => {
  it("success with URL → ingest", () => {
    expect(decidePoll({ state: "success", resultUrl: "https://x/img.png" }, 3)).toEqual({
      action: "ingest",
      resultUrl: "https://x/img.png",
    });
  });
  it("success without URL → fail with clear error", () => {
    const d = decidePoll({ state: "success", resultUrl: null }, 3);
    expect(d.action).toBe("fail");
    if (d.action === "fail") expect(d.error).toContain("no result URL");
  });
  it("fail state → fail", () => {
    expect(decidePoll({ state: "fail", resultUrl: null }, 0).action).toBe("fail");
  });
  it("pending below cap → wait with incremented count", () => {
    expect(decidePoll({ state: "generating", resultUrl: null }, 5)).toEqual({
      action: "wait",
      pollCount: 6,
    });
  });
  it("pending at cap boundary → fail (never waits past POLL_CAP)", () => {
    const d = decidePoll({ state: "queuing", resultUrl: null }, POLL_CAP - 1);
    expect(d.action).toBe("fail");
    if (d.action === "fail") expect(d.error).toContain("poll cap");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test`, FAIL on unresolved import.

- [ ] **Step 3: Implement**

`lib/athena/poll-logic.ts`:

```ts
export const POLL_CAP = 20;

export interface KieRecord {
  state: string;
  resultUrl: string | null;
}

export type PollDecision =
  | { action: "ingest"; resultUrl: string }
  | { action: "fail"; error: string }
  | { action: "wait"; pollCount: number };

export function decidePoll(record: KieRecord, currentPollCount: number): PollDecision {
  if (record.state === "success") {
    if (!record.resultUrl) {
      return { action: "fail", error: "Kie reported success but returned no result URL" };
    }
    return { action: "ingest", resultUrl: record.resultUrl };
  }
  if (record.state === "fail") {
    return { action: "fail", error: "Kie generation failed" };
  }
  const next = currentPollCount + 1;
  if (next >= POLL_CAP) {
    return {
      action: "fail",
      error: `poll cap reached (${POLL_CAP} polls, last state: ${record.state})`,
    };
  }
  return { action: "wait", pollCount: next };
}
```

- [ ] **Step 4: Run to verify pass** — `npm test`, all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/poll-logic.ts tests/poll-logic.test.ts && git commit -m "feat: poll decision logic with 20-poll cap"
```

---

### Task 5: Kie API client wrappers

**Files:**
- Create: `lib/athena/kie.ts`

**Interfaces:**
- Consumes: env `KIE_API_KEY`.
- Produces (used verbatim by Tasks 6/7):
  - `uploadStyleRef(styleRefUrl: string): Promise<string>` → Kie-hosted download URL
  - `createKieTask(prompt: string, styleUrl: string, aspectRatio: string): Promise<string>` → taskId
  - `getKieRecord(taskId: string): Promise<KieRecord>` (the Task 4 type)

No unit tests — these are thin fetch wrappers around a paid external API; they're exercised live in Task 10. Build check only.

- [ ] **Step 1: Implement**

`lib/athena/kie.ts`:

```ts
import "server-only";
import type { KieRecord } from "@/lib/athena/poll-logic";

function kieHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.KIE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function uploadStyleRef(styleRefUrl: string): Promise<string> {
  const res = await fetch("https://kieai.redpandaai.co/api/file-url-upload", {
    method: "POST",
    headers: kieHeaders(),
    body: JSON.stringify({
      fileUrl: styleRefUrl,
      uploadPath: "athena-refs",
      fileName: "style_ref.jpg",
    }),
  });
  const json = await res.json().catch(() => null);
  const url = json?.data?.downloadUrl;
  if (!res.ok || !url) {
    throw new Error(
      `style ref upload failed (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return url as string;
}

export async function createKieTask(
  prompt: string,
  styleUrl: string,
  aspectRatio: string,
): Promise<string> {
  const res = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST",
    headers: kieHeaders(),
    body: JSON.stringify({
      model: "gpt-image-2-image-to-image",
      input: { prompt, input_urls: [styleUrl], aspect_ratio: aspectRatio },
    }),
  });
  const json = await res.json().catch(() => null);
  const taskId = json?.data?.taskId;
  if (!res.ok || !taskId) {
    throw new Error(
      `Kie createTask failed (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return taskId as string;
}

export async function getKieRecord(taskId: string): Promise<KieRecord> {
  const res = await fetch(
    `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { headers: kieHeaders() },
  );
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data) {
    throw new Error(`Kie recordInfo failed (HTTP ${res.status})`);
  }
  const state: string = json.data.state ?? "unknown";
  let resultUrl: string | null = null;
  try {
    const parsed = JSON.parse(json.data.resultJson || '{"resultUrls":[]}');
    resultUrl = parsed.resultUrls?.[0] ?? null;
  } catch {
    resultUrl = null;
  }
  return { state, resultUrl };
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add lib/athena/kie.ts && git commit -m "feat: kie.ai API client wrappers"
```

---

### Task 6: Submit orchestration + `/api/images/generate`

**Files:**
- Create: `lib/athena/submit-generations.ts`, `app/api/images/generate/route.ts`

**Interfaces:**
- Consumes: `uploadStyleRef`/`createKieTask` (Task 5), `buildImagePrompt` (Task 3), `createAdminSupabase`, `requireAllowedUser`.
- Produces: `submitGenerations(ideaIds: string[], refinementNotes?: string): Promise<{ submitted: number; failed: number; skipped: number; errors: string[] }>`; route `POST /api/images/generate` accepting `{ideaIds: string[]}` or `{ideaId: string, refinementNotes?: string}` → that result JSON (401/400/500 per Phase 1 route conventions). Tasks 8/9 call this route.

- [ ] **Step 1: Implement the orchestration lib**

`lib/athena/submit-generations.ts`:

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { uploadStyleRef, createKieTask } from "@/lib/athena/kie";
import { buildImagePrompt } from "@/lib/athena/image-prompt";
import type { Category, Idea } from "@/lib/types";

export interface SubmitResult {
  submitted: number;
  failed: number;
  skipped: number;
  errors: string[];
}

export async function submitGenerations(
  ideaIds: string[],
  refinementNotes = "",
): Promise<SubmitResult> {
  const supabase = createAdminSupabase();

  const { data: ideasData, error: ideasErr } = await supabase
    .from("ideas").select("*").in("id", ideaIds);
  if (ideasErr) throw new Error(`ideas query failed: ${ideasErr.message}`);
  const ideas = (ideasData ?? []) as Idea[];
  if (!ideas.length) throw new Error("no matching ideas");

  // Fresh submit + retry from approved/failed; regenerate from generated only with notes.
  const eligible = ideas.filter(
    (i) =>
      i.status === "approved" ||
      i.status === "failed" ||
      (i.status === "generated" && refinementNotes !== ""),
  );

  const { data: catsData, error: catsErr } = await supabase
    .from("categories").select("*")
    .in("key", [...new Set(eligible.map((i) => i.category_key))]);
  if (catsErr) throw new Error(`categories query failed: ${catsErr.message}`);
  const catMap = new Map(((catsData ?? []) as Category[]).map((c) => [c.key, c]));

  const styleUrlCache = new Map<string, string>();
  const result: SubmitResult = {
    submitted: 0,
    failed: 0,
    skipped: ideas.length - eligible.length,
    errors: [],
  };

  for (const idea of eligible) {
    try {
      const category = catMap.get(idea.category_key);
      if (!category) throw new Error(`no category ${idea.category_key}`);
      let styleUrl = styleUrlCache.get(category.key);
      if (!styleUrl) {
        styleUrl = await uploadStyleRef(category.style_ref_url);
        styleUrlCache.set(category.key, styleUrl);
      }
      const fullPrompt = buildImagePrompt(
        category.style_guide, idea.resolved_prompt, refinementNotes);
      const taskId = await createKieTask(fullPrompt, styleUrl, category.aspect_ratio);
      const { error: insErr } = await supabase.from("generations").insert({
        idea_id: idea.id,
        kie_task_id: taskId,
        status: "submitted",
        kie_style_url: styleUrl,
        full_prompt: fullPrompt,
        refinement_notes: refinementNotes,
      });
      if (insErr) throw new Error(`generation insert failed: ${insErr.message}`);
      await supabase.from("ideas").update({ status: "generating" }).eq("id", idea.id);
      result.submitted++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.failed++;
      result.errors.push(`${idea.id.slice(0, 8)}: ${message}`);
      await supabase.from("generations").insert({
        idea_id: idea.id, status: "failed", error: message,
        refinement_notes: refinementNotes,
      });
      await supabase.from("ideas").update({ status: "failed" }).eq("id", idea.id);
    }
  }
  return result;
}
```

- [ ] **Step 2: Implement the route**

`app/api/images/generate/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { requireAllowedUser } from "@/lib/auth/require-user";
import { submitGenerations } from "@/lib/athena/submit-generations";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    await requireAllowedUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const ideaIds: unknown =
    body?.ideaIds ?? (typeof body?.ideaId === "string" ? [body.ideaId] : null);
  const refinementNotes =
    typeof body?.refinementNotes === "string" ? body.refinementNotes.trim() : "";
  if (
    !Array.isArray(ideaIds) ||
    ideaIds.length === 0 ||
    !ideaIds.every((id) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "expected { ideaIds: string[] } or { ideaId: string }" },
      { status: 400 },
    );
  }

  try {
    const result = await submitGenerations(ideaIds as string[], refinementNotes);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("image submit failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify auth gate + build**

`npm run build`, then with `npm run dev` on a free port:

```bash
curl -s -X POST http://localhost:<port>/api/images/generate \
  -H "Content-Type: application/json" -d '{"ideaId":"x"}'
```

Expected: `{"error":"unauthorized"}` HTTP 401. (Real Kie submission is live-verified in Task 10 — do not attempt it here.)

- [ ] **Step 4: Commit**

```bash
git add lib/athena/submit-generations.ts app/api/images/generate && git commit -m "feat: image generation submit route (kie createTask + generations rows)"
```

---

### Task 7: Poll/ingest route `/api/jobs/poll`

**Files:**
- Create: `app/api/jobs/poll/route.ts`

**Interfaces:**
- Consumes: `getKieRecord` (Task 5), `decidePoll` (Task 4), `createAdminSupabase`, `sharp`, env `CRON_SECRET`.
- Produces: `GET /api/jobs/poll` → `{polled, ingested, failed, pending}` (200) or 401. cron-job.org calls this in Task 10.

- [ ] **Step 1: Implement**

`app/api/jobs/poll/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { getKieRecord } from "@/lib/athena/kie";
import { decidePoll } from "@/lib/athena/poll-logic";
import type { Generation } from "@/lib/types";

export const maxDuration = 120;
const INGEST_CAP = 5;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const header = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

async function ingestImage(
  supabase: SupabaseClient,
  gen: Generation,
  resultUrl: string,
): Promise<void> {
  const res = await fetch(resultUrl);
  if (!res.ok) throw new Error(`image download failed (HTTP ${res.status})`);
  const original = Buffer.from(await res.arrayBuffer());
  const jpeg = await sharp(original).jpeg({ quality: 90 }).toBuffer();
  const path = `${gen.id}.jpg`;
  const { error: upErr } = await supabase.storage
    .from("images")
    .upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
  const { data: pub } = supabase.storage.from("images").getPublicUrl(path);
  const { error: rowErr } = await supabase
    .from("generations")
    .update({ status: "succeeded", image_path: path, public_url: pub.publicUrl })
    .eq("id", gen.id);
  if (rowErr) throw new Error(`generation update failed: ${rowErr.message}`);
  await supabase.from("ideas").update({ status: "generated" }).eq("id", gen.idea_id);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from("generations")
    .select("*")
    .in("status", ["submitted", "polling"])
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const pending = (data ?? []) as Generation[];

  let polled = 0;
  let ingested = 0;
  let failed = 0;

  for (const gen of pending) {
    try {
      polled++;
      const record = await getKieRecord(gen.kie_task_id);
      const decision = decidePoll(record, gen.poll_count);
      if (decision.action === "wait") {
        await supabase
          .from("generations")
          .update({ status: "polling", poll_count: decision.pollCount })
          .eq("id", gen.id);
      } else if (decision.action === "fail") {
        failed++;
        await supabase
          .from("generations")
          .update({ status: "failed", error: decision.error })
          .eq("id", gen.id);
        await supabase.from("ideas").update({ status: "failed" }).eq("id", gen.idea_id);
      } else if (ingested < INGEST_CAP) {
        await ingestImage(supabase, gen, decision.resultUrl);
        ingested++;
      }
      // success beyond INGEST_CAP: leave untouched — next tick ingests it
      // (success never consumes poll_count, so the cap can't expire it).
    } catch (e) {
      // Transient per-row error (network, storage blip): log and let the next
      // tick retry — recordInfo is read-only so nothing is lost.
      console.error(`poll error for generation ${gen.id}:`, e);
    }
  }

  return NextResponse.json({ polled, ingested, failed, pending: pending.length });
}
```

- [ ] **Step 2: Verify locally (no pending rows → cheap, no Kie calls)**

`npm run build`, then with `npm run dev` on a free port (read the secret from `.env.local` into a shell var without printing it):

```bash
cd "/Users/rayyandarugar/Coding Projects/content-gen-app" && set -a; source .env.local; set +a
curl -s -o /dev/null -w "no auth -> HTTP %{http_code}\n" http://localhost:<port>/api/jobs/poll
curl -s -w "\n" http://localhost:<port>/api/jobs/poll -H "Authorization: Bearer ${CRON_SECRET}"
```

Expected: `no auth -> HTTP 401`, then `{"polled":0,"ingested":0,"failed":0,"pending":0}`.

- [ ] **Step 3: Commit**

```bash
git add app/api/jobs && git commit -m "feat: cron poll/ingest route with bounded ingestion"
```

---

### Task 8: Ideas board — "Generate images" button

**Files:**
- Create: `app/(app)/ideas/generate-images-button.tsx`
- Modify: `app/(app)/ideas/page.tsx`

**Interfaces:**
- Consumes: `POST /api/images/generate` (Task 6), existing `Idea` type.
- Produces: per-category button submitting that category's approved idea ids.

- [ ] **Step 1: Client button component**

`app/(app)/ideas/generate-images-button.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function GenerateImagesButton({ ideaIds }: { ideaIds: string[] }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const router = useRouter();

  async function submit() {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/images/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaIds }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setMsg(`Submitted ${json.submitted}${json.failed ? `, ${json.failed} failed` : ""}.`);
      router.refresh();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy ? "Submitting…" : `Generate images (${ideaIds.length})`}
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}
```

- [ ] **Step 2: Wire into the board**

Modify `app/(app)/ideas/page.tsx` — add the import and render the button beside each category heading when that group has approved ideas. Replace the `<h2>` line inside the section map with:

```tsx
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold">{key} ({group.length})</h2>
            {group.some((i) => i.status === "approved") && (
              <GenerateImagesButton
                ideaIds={group.filter((i) => i.status === "approved").map((i) => i.id)}
              />
            )}
          </div>
```

and add at the top: `import { GenerateImagesButton } from "./generate-images-button";`

- [ ] **Step 3: Verify + commit**

`npm run build`; dev-server smoke: `/ideas` still 307-redirects unauthenticated.

```bash
git add app/ && git commit -m "feat: generate-images button on ideas board"
```

---

### Task 9: Gallery page with realtime, retry, regenerate

**Files:**
- Create: `app/(app)/gallery/page.tsx`, `app/(app)/gallery/gallery-card.tsx`, `app/(app)/gallery/realtime-refresher.tsx`

**Interfaces:**
- Consumes: ideas+generations tables, `POST /api/images/generate` (Task 6), `createBrowserSupabase`, `Generation`/`Idea` types, shadcn `dialog`/`textarea`/`badge`/`button`/`card` (already installed).
- Produces: `/gallery` — the nav link goes live.

- [ ] **Step 1: Realtime refresher (client)**

`app/(app)/gallery/realtime-refresher.tsx`:

```tsx
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";

export function RealtimeRefresher() {
  const router = useRouter();
  useEffect(() => {
    const supabase = createBrowserSupabase();
    const channel = supabase
      .channel("generations-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "generations" },
        () => router.refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [router]);
  return null;
}
```

- [ ] **Step 2: Gallery page (server)**

`app/(app)/gallery/page.tsx`:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { GalleryCard } from "./gallery-card";
import { RealtimeRefresher } from "./realtime-refresher";
import type { Generation, Idea } from "@/lib/types";

export type IdeaWithGenerations = Idea & { generations: Generation[] };

export default async function GalleryPage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("ideas")
    .select("*, generations(*)")
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "generations", ascending: false })
    .limit(200);

  const ideas = ((data ?? []) as IdeaWithGenerations[]).filter(
    (i) => i.generations.length > 0,
  );

  const byCategory = new Map<string, IdeaWithGenerations[]>();
  for (const idea of ideas) {
    byCategory.set(idea.category_key, [...(byCategory.get(idea.category_key) ?? []), idea]);
  }

  return (
    <div className="space-y-8">
      <RealtimeRefresher />
      <h1 className="text-2xl font-bold">Gallery</h1>
      {ideas.length === 0 && (
        <p>No generations yet — approve ideas and hit Generate images on the Ideas board.</p>
      )}
      {[...byCategory.entries()].map(([key, group]) => (
        <section key={key} className="space-y-3">
          <h2 className="text-lg font-semibold">{key} ({group.length})</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {group.map((idea) => <GalleryCard key={idea.id} idea={idea} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Gallery card (client)**

`app/(app)/gallery/gallery-card.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import type { IdeaWithGenerations } from "./page";

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  submitted: "outline", polling: "secondary", succeeded: "default", failed: "destructive",
};

export function GalleryCard({ idea }: { idea: IdeaWithGenerations }) {
  const latest = idea.generations[0];
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const router = useRouter();

  async function submit(refinementNotes?: string) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/images/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId: idea.id, refinementNotes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      if (json.failed > 0) throw new Error(json.errors?.[0] ?? "submit failed");
      setDialogOpen(false);
      setNotes("");
      router.refresh();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <Badge variant={statusVariant[latest.status] ?? "outline"}>{latest.status}</Badge>
        <div className="flex gap-2">
          {latest.status === "failed" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => submit()}>
              Retry
            </Button>
          )}
          {latest.status === "succeeded" && (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">Regenerate…</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Regenerate with notes</DialogTitle>
                </DialogHeader>
                <Textarea
                  rows={4}
                  placeholder="What should change? (appended to the prompt)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <Button disabled={busy || !notes.trim()} onClick={() => submit(notes.trim())}>
                  {busy ? "Submitting…" : "Regenerate"}
                </Button>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {latest.status === "succeeded" && latest.public_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={latest.public_url} alt={idea.concept.slice(0, 80)}
            className="w-full rounded border object-cover" />
        ) : latest.status === "failed" ? (
          <p className="text-sm text-red-500 break-words">{latest.error || "failed"}</p>
        ) : (
          <p className="text-sm text-muted-foreground animate-pulse">
            Generating… (polls: {latest.poll_count})
          </p>
        )}
        <p className="text-xs text-muted-foreground line-clamp-2">{idea.concept}</p>
        {latest.refinement_notes && (
          <p className="text-xs text-muted-foreground">Notes: {latest.refinement_notes}</p>
        )}
        {idea.generations.length > 1 && (
          <Dialog>
            <DialogTrigger asChild>
              <button className="text-xs underline text-muted-foreground">
                history ({idea.generations.length})
              </button>
            </DialogTrigger>
            <DialogContent className="max-h-[80vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Generation history</DialogTitle></DialogHeader>
              {idea.generations.map((g) => (
                <div key={g.id} className="space-y-1 border-b pb-3">
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant[g.status] ?? "outline"}>{g.status}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(g.created_at).toLocaleString()}
                    </span>
                  </div>
                  {g.public_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={g.public_url} alt="" className="h-40 rounded border object-cover" />
                  )}
                  {g.refinement_notes && (
                    <p className="text-xs text-muted-foreground">Notes: {g.refinement_notes}</p>
                  )}
                  {g.error && <p className="text-xs text-red-500">{g.error}</p>}
                </div>
              ))}
            </DialogContent>
          </Dialog>
        )}
        {msg && <p className="text-xs text-red-500">{msg}</p>}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Verify + commit**

`npm run build`; dev-server smoke: `/gallery` 307-redirects unauthenticated; `npm test` still green.

```bash
git add app/ && git commit -m "feat: gallery with realtime status, retry, and regenerate-with-notes"
```

---

### Task 10: Deploy, cron setup, production acceptance (USER CHECKPOINT)

**Files:** none (config + verification only).

**Interfaces:**
- Consumes: everything above; migration 0003 already applied (Task 1).
- Produces: Phase 2 live in production.

- [ ] **Step 1: Push to main**

Merge/push per repo convention (work happens on a `phase-2-images` branch; fast-forward into `main`, push — Vercel auto-deploys).

- [ ] **Step 2: USER — add `CRON_SECRET` to Vercel**

Vercel dashboard → content-gen → Settings → Environment Variables → add `CRON_SECRET` with the value from `.env.local` (all environments). Redeploy if prompted.

- [ ] **Step 3: Verify the poll endpoint in production**

```bash
curl -s -o /dev/null -w "no auth -> HTTP %{http_code}\n" https://content-gen-lilac.vercel.app/api/jobs/poll
curl -s https://content-gen-lilac.vercel.app/api/jobs/poll -H "Authorization: Bearer ${CRON_SECRET}"
```

Expected: 401 then `{"polled":0,...}` (secret sourced from `.env.local`, never printed).

- [ ] **Step 4: USER — create the cron job**

At cron-job.org (free account): create job → URL `https://content-gen-lilac.vercel.app/api/jobs/poll` → schedule every 1 minute → add request header `Authorization: Bearer <CRON_SECRET value>` → save & enable. Confirm the job's execution log shows HTTP 200 responses.

- [ ] **Step 5: Production acceptance (live Kie run, ~1 image, costs pennies)**

In the production UI: approve one idea (or use an already-approved one) → Ideas board → "Generate images (1)" → Gallery shows the card at `submitted`/`polling` → within a few minutes (Kie 1–5 min + ≤60s cron) the image appears live without a manual refresh (Realtime) → click "Regenerate…" with a note (e.g. "make the background lighter") → second generation appears and completes → history shows both attempts. Verify in Supabase Storage that `images/<generation_id>.jpg` objects exist and are JPEG.

- [ ] **Step 6: Tag**

```bash
git tag phase-2 && git push origin phase-2
```

---

## Self-Review Notes

- **Spec coverage:** migration §4 (T1), Kie mechanics §3 (T5), prompt §3 (T3), submit flow §5 (T6), poll flow incl. caps/idempotency §5 (T4, T7), ideas-board button §6 (T8), gallery + realtime + retry + refinement §5 (T9), cron + checkpoints §2/§8 (T2, T10), testing §9 (T3/T4 unit + T10 live).
- **Type consistency:** `KieRecord` defined once (T4), imported by T5/T7; `decidePoll`, `buildImagePrompt`, `submitGenerations`, `IdeaWithGenerations` names match at definition and every call site; route body shapes in T8/T9 match T6's parser.
- **Known accepted limitation (by design, documented in T7 code comment):** a *persistently* failing ingest (e.g. storage misconfig) retries every tick without a counter — visible in cron logs and recoverable via the gallery Retry button; poll_count intentionally never increments on success so the ingest-cap deferral can't expire a finished image.
