import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { uploadStyleRef, createKieTask } from "@/lib/athena/kie";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import { requireKieKey } from "@/lib/settings/user-secrets";
import { isSubmitEligible } from "@/lib/athena/submit-eligibility";
import { resolveRoleRef, roleRefUploadKey } from "@/lib/athena/role-refs";
import type { Category, Idea, Slide } from "@/lib/types";

export interface SubmitResult {
  submitted: number;
  failed: number;
  skipped: number;
  errors: string[];
}

export async function submitGenerations(
  userId: string,
  ideaIds: string[],
  refinementNotes = "",
): Promise<SubmitResult> {
  const supabase = createAdminSupabase();
  const kieKey = await requireKieKey(userId);

  const { data: ideasData, error: ideasErr } = await supabase
    .from("ideas").select("*").eq("user_id", userId).in("id", ideaIds);
  if (ideasErr) throw new Error(`ideas query failed: ${ideasErr.message}`);
  const ideas = (ideasData ?? []) as Idea[];
  if (!ideas.length) throw new Error("no matching ideas");

  // A "generating" idea is only eligible once nothing is still in flight for
  // it — see isSubmitEligible for why. Only bother querying for ideas that
  // are actually in that status.
  const generatingIds = ideas.filter((i) => i.status === "generating").map((i) => i.id);
  let inFlightIdeaIds = new Set<string>();
  if (generatingIds.length) {
    const { data: inFlightRows, error: inFlightErr } = await supabase
      .from("generations")
      .select("idea_id")
      .in("idea_id", generatingIds)
      .in("status", ["submitted", "polling"]);
    if (inFlightErr) throw new Error(`in-flight query failed: ${inFlightErr.message}`);
    inFlightIdeaIds = new Set((inFlightRows ?? []).map((r) => r.idea_id as string));
  }

  const eligible = ideas.filter((i) =>
    isSubmitEligible(i.status, refinementNotes, inFlightIdeaIds.has(i.id)),
  );

  const { data: catsData, error: catsErr } = await supabase
    .from("categories").select("*").eq("user_id", userId)
    .in("key", [...new Set(eligible.map((i) => i.category_key))]);
  if (catsErr) throw new Error(`categories query failed: ${catsErr.message}`);
  const catMap = new Map(((catsData ?? []) as Category[]).map((c) => [c.key, c]));

  // Keyed by the upload key (roleRefUploadKey), not the bare category key —
  // two roles (or a role ref vs. the brand fallback) within the same category
  // upload to distinct Kie paths and must not collide in this cache.
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
      // Migration 0008's backfill only touched rows that existed at the time
      // it ran. Any idea inserted between then and the deploy of the code
      // that writes slides has slides = '[]' with a real concept — self-heal
      // it the same way the backfill did, rather than failing it, so a
      // production gap doesn't quietly condemn otherwise-good ideas.
      let slides = (idea.slides ?? []) as Slide[];
      if (!slides.length) {
        if (!idea.concept.trim()) throw new Error("idea has no slides and no concept");
        slides = [{ role: "single", text: "", visual: idea.concept }];
      }

      // Only the anchor is submitted here. The poll cron fans out the rest
      // once this image exists, because they reference it.
      const anchor = slides[0];
      const refUrl = resolveRoleRef(category, anchor.role);
      const usedRoleRef = !!category.role_ref_urls?.[anchor.role];
      const uploadKey = roleRefUploadKey(category.key, anchor.role, usedRoleRef);
      let styleUrl = styleUrlCache.get(uploadKey);
      if (!styleUrl) {
        styleUrl = await uploadStyleRef(kieKey, refUrl, userId, uploadKey);
        styleUrlCache.set(uploadKey, styleUrl);
      }
      const fullPrompt = buildSlidePrompt(
        category.style_guide, anchor, 1, slides.length, false, refinementNotes,
        category.role_guides);
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
      if (insErr) throw new Error(`generation insert failed: ${insErr.message}`);
      await supabase.from("ideas").update({ status: "generating" }).eq("id", idea.id).eq("user_id", userId);
      result.submitted++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.failed++;
      result.errors.push(`${idea.id.slice(0, 8)}: ${message}`);
      await supabase.from("generations").insert({
        user_id: userId,
        idea_id: idea.id, status: "failed", error: message,
        refinement_notes: refinementNotes,
      });
      await supabase.from("ideas").update({ status: "failed" }).eq("id", idea.id).eq("user_id", userId);
    }
  }
  return result;
}
