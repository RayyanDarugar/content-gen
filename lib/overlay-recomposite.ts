import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { compositeOverlays, overlaysForRole } from "@/lib/athena/overlay-composite";
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
  //
  // idea.slides = [] is a documented production case (lib/athena/
  // submit-generations.ts), and ingest (app/api/jobs/poll/route.ts) treats
  // such an idea as one implicit "single"-role slide rather than zero slides.
  // slideIndexesForRoles([], roles) returns [] regardless of roles, which
  // would otherwise make filling a slot silently do nothing for exactly the
  // ideas ingest already composited. Mirror ingest's assumption instead of
  // bailing.
  const slides = idea.slides ?? [];
  let genQuery = supabase
    .from("generations").select("*")
    .eq("idea_id", ideaId).eq("user_id", userId).eq("status", "succeeded");

  if (slides.length > 0) {
    const indexes = slideIndexesForRoles(slides, changed.roles);
    if (indexes.length === 0) return { updated: 0, failed: 0 };
    genQuery = genQuery.in("slide_index", indexes);
  } else if (!changed.roles.includes("single")) {
    // No slides means every generation implicitly has role "single"; if this
    // overlay doesn't apply to "single" it can't apply to this idea at all.
    return { updated: 0, failed: 0 };
  }

  const { data: genRows } = await genQuery;
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
      //
      // But compositeOverlays returning null is ambiguous on its own: it also
      // covers "every applicable layer's fetch/decode threw" (e.g. a
      // transient 503 from the overlay host) — compositeOverlays swallows
      // that per-layer and never rethrows. Clearing composited_url is still
      // correct in that case (stale is worse than blank), but it must NOT be
      // reported as a successful update: a transient outage would otherwise
      // permanently blank a good composite while telling the caller nothing
      // went wrong. overlaysForRole distinguishes the two: if it's non-empty,
      // layers did apply to this role and all of them failed.
      let compositedUrl = "";
      let compositeFailed = false;
      if (composited) {
        compositedUrl = (await uploadImageToCloudinary(composited, "image/jpeg")).url;
      } else if (overlaysForRole(resolved, role).length > 0) {
        compositeFailed = true;
        console.error(
          `re-composite for generation ${gen.id}: all overlay layers failed for role "${role}"; ` +
          "clearing composited_url and reporting failure, not success",
        );
      }

      const { error } = await supabase
        .from("generations").update({ composited_url: compositedUrl })
        .eq("id", gen.id).eq("user_id", userId);
      if (error) throw new Error(error.message);

      if (compositeFailed) failed++;
      else updated++;
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
