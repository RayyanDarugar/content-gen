import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createKieTask } from "@/lib/athena/kie";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import { requireKieKey } from "@/lib/settings/user-secrets";
import { currentAnchor } from "@/lib/athena/fanout";
import type { Category, Generation, Idea, Slide } from "@/lib/types";

export interface ResubmitResult {
  submitted: number;
  slideIndex: number;
}

// Retrying ONE slide of a carousel, against the anchor its siblings already
// used. Without this, retrying a failed slide 4 went through submitGenerations,
// which only ever submits slide 0 — so it re-anchored the carousel and the
// fan-out then regenerated all five images, discarding four good ones and
// spending five generations to recover one. Spec §5.6 always called for this
// path; it just was never built.
//
// Slide 0 is deliberately NOT handled here: replacing the anchor invalidates
// every sibling built against it, which is a whole-carousel regeneration and
// belongs in submitGenerations.
export async function resubmitSlide(
  userId: string,
  ideaId: string,
  slideIndex: number,
  refinementNotes = "",
): Promise<ResubmitResult> {
  if (slideIndex <= 0) {
    throw new Error("slide 0 is the anchor — regenerate the whole carousel instead");
  }

  const supabase = createAdminSupabase();
  const kieKey = await requireKieKey(userId);

  const { data: ideaRow, error: ideaErr } = await supabase
    .from("ideas").select("*").eq("id", ideaId).eq("user_id", userId).single();
  if (ideaErr || !ideaRow) throw new Error(`idea not found: ${ideaErr?.message ?? ideaId}`);
  const idea = ideaRow as Idea;

  const slides = (idea.slides ?? []) as Slide[];
  if (slideIndex >= slides.length) {
    throw new Error(`slide ${slideIndex} does not exist on this idea`);
  }

  const { data: genRows, error: genErr } = await supabase
    .from("generations").select("*").eq("idea_id", ideaId).eq("user_id", userId);
  if (genErr) throw new Error(`generations query failed: ${genErr.message}`);
  const gens = (genRows ?? []) as Generation[];

  // Nothing in flight for this slide already — otherwise a double click, or a
  // click while the cron is mid-poll, spends a second paid generation.
  if (gens.some((g) => g.slide_index === slideIndex && ["submitted", "polling"].includes(g.status))) {
    throw new Error(`slide ${slideIndex + 1} is still generating`);
  }

  const anchor = currentAnchor(gens);
  if (!anchor) {
    throw new Error("no succeeded opening image to match — regenerate the whole carousel");
  }

  const { data: catRow, error: catErr } = await supabase
    .from("categories").select("*").eq("user_id", userId).eq("key", idea.category_key).single();
  if (catErr || !catRow) throw new Error(`category lookup failed: ${catErr?.message}`);
  const category = catRow as Category;

  const prompt = buildSlidePrompt(
    category.style_guide, slides[slideIndex], slideIndex + 1, slides.length, true,
    refinementNotes, category.role_guides);

  const taskId = await createKieTask(
    kieKey, prompt, [anchor.kie_style_url, anchor.public_url], category.aspect_ratio);

  const { error: insErr } = await supabase.from("generations").insert({
    user_id: userId,
    idea_id: ideaId,
    kie_task_id: taskId,
    status: "submitted",
    slide_index: slideIndex,
    anchor_generation_id: anchor.id,
    kie_style_url: anchor.kie_style_url,
    full_prompt: prompt,
    refinement_notes: refinementNotes,
  });
  if (insErr) {
    throw new Error(
      `slide submitted to Kie (task ${taskId}) but the row failed to save: ${insErr.message}`,
    );
  }

  // The idea left `generated` if it ever got there — a slide is in flight again.
  await supabase.from("ideas").update({ status: "generating" })
    .eq("id", ideaId).eq("user_id", userId).in("status", ["generated", "failed"]);

  return { submitted: 1, slideIndex };
}
