import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { getKieRecord, createKieTask } from "@/lib/athena/kie";
import { decidePoll } from "@/lib/athena/poll-logic";
import {
  shouldFanOut,
  slideIndexesToFanOut,
  isCarouselComplete,
  shouldRetryAnchor,
  succeededIndexesUnderCurrentAnchor,
  orphanedTaskFailureRow,
} from "@/lib/athena/fanout";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import { getKieKeyOrNull } from "@/lib/settings/user-secrets";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import type { Category, Generation, Idea } from "@/lib/types";

export const maxDuration = 120;
const INGEST_CAP = 5;
// Bounds sweepOrphanedAnchors the same way INGEST_CAP bounds the main loop:
// SWEEP_IDEA_CAP is a cheap candidate-fetch limit, FAN_OUT_SWEEP_CAP caps how
// many paid fan-outs one tick can attempt.
const SWEEP_IDEA_CAP = 50;
const FAN_OUT_SWEEP_CAP = 5;

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

  for (const index of slideIndexesToFanOut(slides.length)) {
    const prompt = buildSlidePrompt(
      category.style_guide, slides[index], index + 1, slides.length, true,
      anchor.refinement_notes);
    let taskId: string;
    try {
      taskId = await createKieTask(
        apiKey, prompt, [anchor.kie_style_url, anchorImageUrl], category.aspect_ratio);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const { error: failErr } = await supabase.from("generations").insert({
        user_id: anchor.user_id,
        idea_id: idea.id,
        status: "failed",
        slide_index: index,
        anchor_generation_id: anchor.id,
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
      kie_style_url: anchor.kie_style_url,
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
    category.style_guide, slides[0], 1, slides.length, false, failed.refinement_notes);
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

  return NextResponse.json({ polled, ingested, failed, pending: pending.length, sweptFanOuts });
}
