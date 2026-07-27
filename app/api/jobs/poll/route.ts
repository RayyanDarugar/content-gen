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
} from "@/lib/athena/fanout";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import { getKieKeyOrNull } from "@/lib/settings/user-secrets";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import type { Category, Generation, Idea } from "@/lib/types";

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

  return NextResponse.json({ polled, ingested, failed, pending: pending.length });
}
