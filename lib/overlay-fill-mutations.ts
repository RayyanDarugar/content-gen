import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { IdeaOverlayFill } from "@/lib/types";

// These *ForUser functions take the tenant's userId as a parameter and do NOT
// authenticate — every caller must have established who the user is first.
// That is why they live here and not in a "use server" file, where every
// export becomes a POST-reachable endpoint. Same pattern as
// lib/category-mutations.ts and lib/overlay-mutations.ts.
//
// The admin client bypasses RLS, so every query filters by user_id explicitly.

export async function listFillsForIdea(
  ideaId: string,
  userId: string,
): Promise<IdeaOverlayFill[]> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("idea_overlay_fills").select("*")
    .eq("idea_id", ideaId).eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data ?? []) as IdeaOverlayFill[];
}

export async function setOverlayFillForUser(
  userId: string,
  ideaId: string,
  overlayId: string,
  imageUrl: string,
): Promise<void> {
  if (!imageUrl.trim()) throw new Error("Upload an image for the slot");
  const supabase = createAdminSupabase();

  // Both ids arrive from the client, and the admin client would otherwise
  // happily attach a fill to another tenant's idea or overlay.
  const { data: idea } = await supabase
    .from("ideas").select("id").eq("id", ideaId).eq("user_id", userId).maybeSingle();
  if (!idea) throw new Error("unknown idea");
  const { data: overlay } = await supabase
    .from("category_overlays").select("id, is_slot")
    .eq("id", overlayId).eq("user_id", userId).maybeSingle();
  if (!overlay) throw new Error("unknown overlay");
  if (!(overlay as { is_slot: boolean }).is_slot) {
    throw new Error("that overlay is not a slot");
  }

  // Columns enumerated, never spread: types are erased at the "use server"
  // boundary these are reached through.
  const { error } = await supabase.from("idea_overlay_fills").upsert(
    { user_id: userId, idea_id: ideaId, overlay_id: overlayId, image_url: imageUrl },
    { onConflict: "idea_id,overlay_id" },
  );
  if (error) throw new Error(error.message);
}

export async function clearOverlayFillForUser(
  userId: string,
  ideaId: string,
  overlayId: string,
): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("idea_overlay_fills").delete()
    .eq("idea_id", ideaId).eq("overlay_id", overlayId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}
