import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { uploadStyleRef, createKieTask } from "@/lib/athena/kie";
import { buildImagePrompt } from "@/lib/athena/image-prompt";
import { requireKieKey } from "@/lib/settings/user-secrets";
import type { Category, Idea } from "@/lib/types";

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

  // Fresh submit + retry from approved/failed; regenerate from generated only with notes.
  const eligible = ideas.filter(
    (i) =>
      i.status === "approved" ||
      i.status === "failed" ||
      (i.status === "generated" && refinementNotes !== ""),
  );

  const { data: catsData, error: catsErr } = await supabase
    .from("categories").select("*").eq("user_id", userId)
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
        styleUrl = await uploadStyleRef(kieKey, category.style_ref_url);
        styleUrlCache.set(category.key, styleUrl);
      }
      const fullPrompt = buildImagePrompt(
        category.style_guide, idea.resolved_prompt, refinementNotes);
      const taskId = await createKieTask(kieKey, fullPrompt, styleUrl, category.aspect_ratio);
      const { error: insErr } = await supabase.from("generations").insert({
        user_id: userId,
        idea_id: idea.id,
        kie_task_id: taskId,
        status: "submitted",
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
