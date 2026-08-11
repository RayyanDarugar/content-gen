import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { getKieRecord, createKieTask, uploadStyleRef } from "@/lib/athena/kie";
import { decidePoll, POLL_CAP } from "@/lib/athena/poll-logic";
import {
  shouldFanOut,
  slideIndexesToFanOut,
  isCarouselComplete,
  shouldRetryAnchor,
  succeededIndexesUnderCurrentAnchor,
  orphanedTaskFailureRow,
} from "@/lib/athena/fanout";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import { resolveRoleRef, roleRefUploadKey } from "@/lib/athena/role-refs";
import { getKieKeyOrNull } from "@/lib/settings/user-secrets";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import { compositeOverlays } from "@/lib/athena/overlay-composite";
import { listOverlaysForCategory } from "@/lib/overlay-mutations";
import type { Category, Generation, Idea, StyleRefJob } from "@/lib/types";

export const maxDuration = 120;
const INGEST_CAP = 5;
// Bounds sweepOrphanedAnchors the same way INGEST_CAP bounds the main loop:
// SWEEP_IDEA_CAP is a cheap candidate-fetch limit, FAN_OUT_SWEEP_CAP caps how
// many paid fan-outs one tick can attempt.
const SWEEP_IDEA_CAP = 50;
const FAN_OUT_SWEEP_CAP = 5;
// Single-image, no fan-out — a much smaller cap than INGEST_CAP is fine.
const STYLE_REF_POLL_CAP = 10;
const STYLE_REF_MAX_BYTES = 15 * 1024 * 1024;
// Ingest (download + Cloudinary upload + two DB writes) is much heavier than
// a bare poll — bounded separately from STYLE_REF_POLL_CAP (which only
// limits how many rows get fetched/poll-checked at all) so a busy tick can't
// let style-ref ingestion eat the whole shared 120s cron budget, mirroring
// how INGEST_CAP bounds the main generations loop's own equivalent work.
const STYLE_REF_INGEST_CAP = 3;

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

  // Overlays produce a SECOND artifact. public_url above stays the clean
  // image because fanOutCarousel (just below), sweepOrphanedAnchors, and
  // lib/athena/resubmit-slide.ts all hand it to Kie as the carousel anchor —
  // compositing in place would burn a QR code into the model's visual
  // reference for every later slide.
  //
  // Wrapped whole: this generation's status is already committed as
  // succeeded, so a compositing failure must not throw past here and must
  // not block the fan-out below.
  try {
    const { data: catRow } = await supabase
      .from("categories").select("id")
      .eq("key", idea.category_key).eq("user_id", gen.user_id).maybeSingle();
    if (catRow) {
      const overlays = await listOverlaysForCategory((catRow as { id: string }).id, gen.user_id);
      const role = (idea.slides ?? [])[gen.slide_index]?.role ?? "single";
      const composited = await compositeOverlays(jpeg, overlays, role);
      if (composited) {
        const { url: compositedUrl } = await uploadImageToCloudinary(composited, "image/jpeg");
        const { error: compErr } = await supabase
          .from("generations").update({ composited_url: compositedUrl }).eq("id", gen.id);
        if (compErr) throw new Error(compErr.message);
      }
    }
  } catch (e) {
    console.error(`compositing failed for generation ${gen.id}:`, e);
  }

  // Fan out the rest of the carousel against this anchor.
  if (gen.slide_index === 0) {
    const { count, error: sibErr } = await supabase
      .from("generations")
      .select("*", { count: "exact", head: true })
      .eq("anchor_generation_id", gen.id);
    if (sibErr) throw new Error(`sibling count failed: ${sibErr.message}`);
    if (shouldFanOut(slideCount, count ?? 0)) {
      try {
        await fanOutCarousel(supabase, gen, idea, url);
      } catch (e) {
        // The status update above already committed, so this generation is
        // no longer in the "submitted"/"polling" set the main loop selects —
        // nothing else would ever revisit it. sweepOrphanedAnchors() finds
        // succeeded slide-0 rows with zero siblings on a later tick and
        // retries this exact call, using the same shouldFanOut/zero-siblings
        // rule, so retrying here is safe and idempotent.
        console.error(`fan-out failed for anchor ${gen.id}, sweep will retry:`, e);
      }
    }
  }

  // The idea completes only when every slide has an image *under the same
  // anchor* (spec §5.6 — "exact rather than count-based"). Aggregating
  // across the whole idea would let a freshly-regenerated anchor pair up
  // with a previous anchor's leftover siblings and falsely complete.
  const { data: doneRows, error: doneErr } = await supabase
    .from("generations")
    .select("id, slide_index, anchor_generation_id, created_at")
    .eq("idea_id", gen.idea_id)
    .eq("status", "succeeded");
  if (doneErr) throw new Error(`completion query failed: ${doneErr.message}`);
  const succeeded = succeededIndexesUnderCurrentAnchor(doneRows ?? []);
  if (isCarouselComplete(slideCount, succeeded)) {
    // A posted idea must never be resurrected back to "generated" — a slide
    // landing after the carousel was already (partially) posted would
    // otherwise orphan the post record and reintroduce its images as
    // postable. See app/api/posts/create/route.ts.
    await supabase
      .from("ideas")
      .update({ status: "generated" })
      .eq("id", gen.idea_id)
      .neq("status", "posted");
  }
}

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

  const { data: catRow, error: catErr } = await supabase
    .from("categories").select("*")
    .eq("user_id", anchor.user_id).eq("key", idea.category_key).single();
  if (catErr || !catRow) {
    throw new Error(
      `category ${idea.category_key} lookup failed: ${catErr?.message ?? "not found"}`,
    );
  }
  const category = catRow as Category;
  const slides = idea.slides ?? [];

  // Per-role uploads, cached within this one fan-out call so N beats sharing
  // a role (or repeat calls for the same role) don't re-upload N times. Only
  // populated for roles that actually have a promoted ref — see resolveRoleRef.
  const roleRefUrlCache = new Map<string, string>();

  for (const index of slideIndexesToFanOut(slides.length)) {
    const slideRole = slides[index].role;
    const prompt = buildSlidePrompt(
      category.style_guide, slides[index], index + 1, slides.length, true,
      anchor.refinement_notes, category.role_guides);
    // refUrl defaults to the anchor's own ref (pre-role-ref behavior) and is
    // only reassigned below if this slide's role has a promoted ref to
    // upload. Left at the anchor's value, it is genuinely correct — a
    // role-less slide is SUPPOSED to fall back to the anchor's ref — so it
    // must never be stored on a failed row from a scope where it might still
    // hold that default despite the slide actually having its own role ref
    // (see the inner catch below, which deliberately omits it for exactly
    // that reason).
    let refUrl = anchor.kie_style_url;
    // The upload is a network call to Kie and can fail transiently just like
    // createKieTask. It needs its own try/catch, separate from createKieTask's
    // below: on an upload failure, refUrl is still the anchor's stale default
    // (never reassigned), which is the WRONG role's ref for this slide — a
    // failed row must not carry it, or a later resubmitSlide retry would read
    // it back via mostRecentForSlide as a "usable" prior and silently
    // regenerate against the anchor's ref instead of re-resolving this
    // slide's actual role ref. (Previously this upload sat outside every
    // try/catch, so a failure here threw out of the whole fan-out loop
    // instead of failing just this one slide — later slides never got
    // submitted, no failed row existed for the retry machinery to find, and
    // the orphan sweep's zero-siblings gate meant nothing would ever revisit
    // this anchor either.)
    if (category.role_ref_urls?.[slideRole]) {
      const cached = roleRefUrlCache.get(slideRole);
      if (cached) {
        refUrl = cached;
      } else {
        try {
          refUrl = await uploadStyleRef(
            apiKey, resolveRoleRef(category, slideRole), anchor.user_id,
            roleRefUploadKey(category.key, slideRole, true));
          roleRefUrlCache.set(slideRole, refUrl);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const { error: failErr } = await supabase.from("generations").insert({
            user_id: anchor.user_id,
            idea_id: idea.id,
            status: "failed",
            slide_index: index,
            anchor_generation_id: anchor.id,
            // Deliberately no kie_style_url: refUrl here is still the
            // anchor's default, not this slide's role ref (the upload that
            // would have produced it just failed) — see the comment above.
            error: message,
          });
          if (failErr) {
            console.error(
              `fan-out role-ref upload failed-row insert error for idea ${idea.id} slide ${index}:`,
              failErr.message,
            );
          }
          continue;
        }
      }
    }
    let taskId: string;
    try {
      taskId = await createKieTask(
        apiKey, prompt, [refUrl, anchorImageUrl], category.aspect_ratio);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const { error: failErr } = await supabase.from("generations").insert({
        user_id: anchor.user_id,
        idea_id: idea.id,
        status: "failed",
        slide_index: index,
        anchor_generation_id: anchor.id,
        // refUrl is genuinely this slide's ref at this point — either the
        // freshly uploaded (or cached) role ref, or the anchor's ref for a
        // role-less slide — so it's safe to store here.
        kie_style_url: refUrl,
        error: message,
      });
      if (failErr) {
        console.error(
          `fan-out failed-row insert error for idea ${idea.id} slide ${index}:`,
          failErr.message,
        );
      }
      continue;
    }
    // supabase.insert() returns { error } rather than throwing, so this must
    // be checked explicitly. Left unchecked, a partial failure here leaves a
    // paid Kie task with no row to poll it — invisible spend — and the
    // sibling count shouldFanOut relies on never reaches slides.length - 1,
    // so the orphan sweep would never see this anchor as needing another
    // pass either.
    const { error: insErr } = await supabase.from("generations").insert({
      user_id: anchor.user_id,
      idea_id: idea.id,
      kie_task_id: taskId,
      status: "submitted",
      slide_index: index,
      anchor_generation_id: anchor.id,
      kie_style_url: refUrl,
      full_prompt: prompt,
      refinement_notes: anchor.refinement_notes,
    });
    if (insErr) {
      const { error: failErr } = await supabase.from("generations").insert(
        orphanedTaskFailureRow(
          { user_id: anchor.user_id, idea_id: idea.id, slide_index: index, anchor_generation_id: anchor.id },
          taskId,
          insErr.message,
        ),
      );
      if (failErr) {
        console.error(
          `fan-out orphan-row insert error for idea ${idea.id} slide ${index} (orphaned Kie task ${taskId}):`,
          failErr.message,
        );
      }
    }
  }
}

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
    category.style_guide, slides[0], 1, slides.length, false, failed.refinement_notes,
    category.role_guides);
  const taskId = await createKieTask(
    apiKey, prompt, [failed.kie_style_url], category.aspect_ratio);
  // Checked for the same reason as fanOutCarousel's insert: unchecked, an
  // insert failure here would leave a paid Kie task with no row to poll it.
  const { error: insErr } = await supabase.from("generations").insert({
    user_id: failed.user_id,
    idea_id: failed.idea_id,
    kie_task_id: taskId,
    status: "submitted",
    slide_index: 0,
    kie_style_url: failed.kie_style_url,
    full_prompt: prompt,
    refinement_notes: failed.refinement_notes,
  });
  if (insErr) {
    const { error: failErr } = await supabase.from("generations").insert(
      orphanedTaskFailureRow(
        { user_id: failed.user_id, idea_id: failed.idea_id, slide_index: 0 },
        taskId,
        insErr.message,
      ),
    );
    if (failErr) {
      console.error(
        `anchor retry orphan-row insert error for idea ${failed.idea_id} (orphaned Kie task ${taskId}):`,
        failErr.message,
      );
    }
  }
}

// The main loop above only ever sees rows still in "submitted"/"polling", so
// once ingestImage marks an anchor "succeeded" that row drops out of it for
// good. If the inline fan-out attempt in ingestImage never ran (transient
// error) or never got as far as inserting any sibling (missing key), nothing
// else would revisit it — this sweep is that "something else."
//
// Candidates are found via `ideas.status = 'generating'`. A carousel that
// finishes normally leaves this set the moment isCarouselComplete flips it to
// "generated", but a carousel with a permanently failed slide never leaves —
// the poll loop deliberately stops marking ideas "failed" so a dud slide
// doesn't hide the rest of the carousel's good images. That means this
// candidate set is unbounded and only grows over time, which is exactly why
// it is ordered newest-first: the oldest entries are disproportionately
// permanently-stuck carousels that shouldFanOut below will reject every tick
// forever, and once SWEEP_IDEA_CAP of those accumulate they must not be
// allowed to starve a newly orphaned anchor out of its only recovery path.
async function sweepOrphanedAnchors(supabase: SupabaseClient): Promise<number> {
  const { data: ideaRows, error: ideaErr } = await supabase
    .from("ideas")
    .select("*")
    .eq("status", "generating")
    .order("updated_at", { ascending: false })
    .limit(SWEEP_IDEA_CAP);
  if (ideaErr) {
    console.error("fan-out sweep idea query failed:", ideaErr.message);
    return 0;
  }
  const multiSlideIdeas = ((ideaRows ?? []) as Idea[]).filter((i) => (i.slides ?? []).length > 1);
  if (!multiSlideIdeas.length) return 0;

  const { data: anchorRows, error: anchorErr } = await supabase
    .from("generations")
    .select("*")
    .in("idea_id", multiSlideIdeas.map((i) => i.id))
    .eq("slide_index", 0)
    .eq("status", "succeeded");
  if (anchorErr) {
    console.error("fan-out sweep anchor query failed:", anchorErr.message);
    return 0;
  }

  const ideaById = new Map(multiSlideIdeas.map((i) => [i.id, i]));
  let attempted = 0;
  for (const anchor of (anchorRows ?? []) as Generation[]) {
    if (attempted >= FAN_OUT_SWEEP_CAP) break;
    const idea = ideaById.get(anchor.idea_id);
    if (!idea) continue;
    try {
      const { count, error: sibErr } = await supabase
        .from("generations")
        .select("*", { count: "exact", head: true })
        .eq("anchor_generation_id", anchor.id);
      if (sibErr) throw new Error(`sibling count failed: ${sibErr.message}`);
      const slideCount = (idea.slides ?? []).length;
      if (!shouldFanOut(slideCount, count ?? 0)) continue;
      attempted++;
      await fanOutCarousel(supabase, anchor, idea, anchor.public_url);
    } catch (e) {
      console.error(`fan-out sweep error for anchor ${anchor.id}:`, e);
    }
  }
  return attempted;
}

// Fire-and-forget completion for generate_style_ref (MCP tool). Mirrors the
// main generations-polling loop above: same decidePoll/getKieRecord contract,
// same per-user Kie-key caching, same per-row try/catch so one bad row can't
// stop the rest. Unlike ingestImage, there is no fan-out and no sharp
// recompression — this validates and re-hosts exactly the way the browser's
// own style-ref finalize phase already does (app/api/categories/draft/style-ref/route.ts).
async function pollStyleRefJobs(
  supabase: SupabaseClient,
): Promise<{ polled: number; succeeded: number; failed: number }> {
  const { data, error } = await supabase
    .from("style_ref_jobs")
    .select("*")
    .in("status", ["submitted", "polling"])
    .order("created_at", { ascending: true })
    .limit(STYLE_REF_POLL_CAP);
  if (error) {
    console.error("style ref job query failed:", error.message);
    return { polled: 0, succeeded: 0, failed: 0 };
  }
  const pending = (data ?? []) as StyleRefJob[];

  let polled = 0;
  let succeeded = 0;
  let failed = 0;

  const keyCache = new Map<string, string | null>();
  async function kieKeyFor(uid: string): Promise<string | null> {
    if (!keyCache.has(uid)) keyCache.set(uid, await getKieKeyOrNull(uid));
    return keyCache.get(uid) ?? null;
  }

  for (const job of pending) {
    try {
      const apiKey = await kieKeyFor(job.user_id);
      if (!apiKey) {
        // Unlike a real Kie poll, a missing key can never resolve on its own.
        // Advance poll_count directly so a permanently keyless job eventually
        // ages out via the same POLL_CAP decidePoll enforces elsewhere,
        // rather than occupying every batch forever — FIFO ordering plus
        // this function's own .limit() means a stuck row at the front would
        // otherwise starve every other tenant's style-ref jobs.
        const nextCount = job.poll_count + 1;
        if (nextCount >= POLL_CAP) {
          failed++;
          await supabase
            .from("style_ref_jobs")
            .update({ status: "failed", error: "no Kie API key configured" })
            .eq("id", job.id);
        } else {
          await supabase
            .from("style_ref_jobs")
            .update({ status: "polling", poll_count: nextCount })
            .eq("id", job.id);
        }
        continue;
      }
      polled++;
      const record = await getKieRecord(apiKey, job.kie_task_id);
      const decision = decidePoll(record, job.poll_count);

      if (decision.action === "wait") {
        await supabase
          .from("style_ref_jobs")
          .update({ status: "polling", poll_count: decision.pollCount })
          .eq("id", job.id);
        continue;
      }
      if (decision.action === "fail") {
        failed++;
        await supabase
          .from("style_ref_jobs")
          .update({ status: "failed", error: decision.error })
          .eq("id", job.id);
        continue;
      }

      // decision.action === "ingest"
      if (succeeded >= STYLE_REF_INGEST_CAP) continue; // leave untouched; a later tick ingests it — success never consumes poll_count, so the cap can't expire it.
      const res = await fetch(decision.resultUrl);
      if (!res.ok) throw new Error(`style ref image download failed (HTTP ${res.status})`);
      const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!contentType.startsWith("image/")) {
        throw new Error(`expected an image response, got ${contentType || "unknown content-type"}`);
      }
      const contentLength = res.headers.get("content-length");
      if (contentLength && Number(contentLength) > STYLE_REF_MAX_BYTES) {
        throw new Error("style ref image exceeds 15MB limit");
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > STYLE_REF_MAX_BYTES) throw new Error("style ref image exceeds 15MB limit");

      const { url } = await uploadImageToCloudinary(buffer, contentType);

      const { error: catErr } = await supabase
        .from("categories").update({ style_ref_url: url }).eq("id", job.category_id).eq("user_id", job.user_id);
      if (catErr) throw new Error(`category update failed: ${catErr.message}`);

      const { error: jobErr } = await supabase
        .from("style_ref_jobs").update({ status: "succeeded", style_ref_url: url }).eq("id", job.id);
      if (jobErr) throw new Error(`style ref job update failed: ${jobErr.message}`);

      succeeded++;
    } catch (e) {
      // Transient per-row error (network, storage blip): log and let the next
      // tick retry — recordInfo is read-only so nothing is lost, and the row
      // stays "submitted"/"polling" until decidePoll's own poll cap gives up.
      console.error(`style ref poll error for job ${job.id}:`, e);
    }
  }

  return { polled, succeeded, failed };
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

  const keyCache = new Map<string, string | null>();
  async function kieKeyFor(uid: string): Promise<string | null> {
    if (!keyCache.has(uid)) keyCache.set(uid, await getKieKeyOrNull(uid));
    return keyCache.get(uid) ?? null;
  }

  for (const gen of pending) {
    try {
      const apiKey = await kieKeyFor(gen.user_id);
      if (!apiKey) continue; // owner removed their key; leave the row for a later tick
      polled++;
      const record = await getKieRecord(apiKey, gen.kie_task_id);
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
        // The idea is deliberately left alone. A failed slide is retryable,
        // and marking the whole idea failed would hide its good slides.
        if (gen.slide_index === 0) await retryAnchorIfWorthwhile(supabase, gen);
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

  let sweptFanOuts = 0;
  try {
    sweptFanOuts = await sweepOrphanedAnchors(supabase);
  } catch (e) {
    // Same rationale as the per-row catch above: log and let the next tick
    // retry rather than fail the whole response over a sweep-only error.
    console.error("fan-out sweep failed:", e);
  }

  let styleRefPolled = 0;
  let styleRefSucceeded = 0;
  let styleRefFailed = 0;
  try {
    const result = await pollStyleRefJobs(supabase);
    styleRefPolled = result.polled;
    styleRefSucceeded = result.succeeded;
    styleRefFailed = result.failed;
  } catch (e) {
    console.error("style ref job poll failed:", e);
  }

  return NextResponse.json({
    polled, ingested, failed, pending: pending.length, sweptFanOuts,
    styleRefPolled, styleRefSucceeded, styleRefFailed,
  });
}
