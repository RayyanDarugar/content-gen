import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { compositeOverlays } from "@/lib/athena/overlay-composite";
import { resolveOverlaysForIdea, slideIndexesForRoles } from "@/lib/athena/overlay-slots";
import { listOverlaysForCategory } from "@/lib/overlay-mutations";
import { listFillsForIdea } from "@/lib/overlay-fill-mutations";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import type { CategoryOverlay, Category, Generation, Idea } from "@/lib/types";

// Re-composites the generations one overlay change actually affects.
//
// This is cheap by construction: B1 keeps the clean image in public_url, so a
// re-composite is one sharp pass and one Cloudinary upload — no Kie call and
// no AI spend. That is what makes "add the speaker photo after generating" an
// ordinary action rather than a regeneration.
export async function recompositeIdeaForOverlay(
  userId: string,
  ideaId: string,
  overlayId: string,
): Promise<{ updated: number; failed: number }> {
  const supabase = createAdminSupabase();

  const { data: ideaRow } = await supabase
    .from("ideas").select("*").eq("id", ideaId).eq("user_id", userId).maybeSingle();
  if (!ideaRow) throw new Error("unknown idea");
  const idea = ideaRow as Idea;

  const { data: overlayRow } = await supabase
    .from("category_overlays").select("*")
    .eq("id", overlayId).eq("user_id", userId).maybeSingle();
  if (!overlayRow) throw new Error("unknown overlay");
  const changed = overlayRow as CategoryOverlay;

  const { data: catRow } = await supabase
    .from("categories").select("*")
    .eq("key", idea.category_key).eq("user_id", userId).maybeSingle();
  if (!catRow) throw new Error("unknown category");
  const category = catRow as Category;

  // Only the slides this overlay targets. A payoff-only speaker slot means one
  // re-composite, not one per slide.
  const indexes = slideIndexesForRoles(idea.slides ?? [], changed.roles);
  if (indexes.length === 0) return { updated: 0, failed: 0 };

  const { data: genRows } = await supabase
    .from("generations").select("*")
    .eq("idea_id", ideaId).eq("user_id", userId).eq("status", "succeeded")
    .in("slide_index", indexes);
  const generations = (genRows ?? []) as Generation[];
  if (generations.length === 0) return { updated: 0, failed: 0 };

  const overlays = await listOverlaysForCategory(category.id, userId);
  const fills = await listFillsForIdea(ideaId, userId);
  const { resolved } = resolveOverlaysForIdea(overlays, fills);

  let updated = 0;
  let failed = 0;

  for (const gen of generations) {
    try {
      // Always re-composite from the CLEAN image. Compositing a composited
      // image would stack the old overlay under the new one.
      const res = await fetch(gen.public_url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`clean image fetch failed (HTTP ${res.status})`);
      const base = Buffer.from(await res.arrayBuffer());

      const role = (idea.slides ?? [])[gen.slide_index]?.role ?? "single";
      const composited = await compositeOverlays(base, resolved, role);

      // THE ASYMMETRY (spec §5). At ingest, a null means "there was never
      // anything to composite" and nothing is written. Here it can instead
      // mean "the last applicable overlay just went away" — and leaving the
      // old value in place would keep publishing the speaker that was just
      // deleted. So null clears the column rather than skipping the write.
      let compositedUrl = "";
      if (composited) {
        compositedUrl = (await uploadImageToCloudinary(composited, "image/jpeg")).url;
      }

      const { error } = await supabase
        .from("generations").update({ composited_url: compositedUrl })
        .eq("id", gen.id).eq("user_id", userId);
      if (error) throw new Error(error.message);
      updated++;
    } catch (e) {
      // Each generation is independent: one failure leaves that slide stale
      // but correct, and re-saving fixes it. Aborting the loop would leave
      // nothing updated, which is strictly worse.
      console.error(`re-composite failed for generation ${gen.id}:`, e);
      failed++;
    }
  }

  return { updated, failed };
}
