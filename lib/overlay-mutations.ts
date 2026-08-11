import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { CategoryOverlay } from "@/lib/types";
import { validateOverlayFields, type OverlayFields } from "@/lib/overlays";

// These *ForUser-style functions take the tenant's userId as a parameter and
// do NOT authenticate — every caller must have established who the user is
// first. That is why they live here and not in a "use server" file, where
// every export becomes a POST-reachable endpoint. Same pattern and same
// reasoning as lib/category-mutations.ts.

// Filtered by BOTH category and user: the admin client bypasses RLS, so the
// tenant predicate has to be explicit.
export async function listOverlaysForCategory(
  categoryId: string,
  userId: string,
): Promise<CategoryOverlay[]> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("category_overlays").select("*")
    .eq("category_id", categoryId).eq("user_id", userId)
    .order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as CategoryOverlay[];
}

export async function createOverlayForUser(
  userId: string, categoryId: string, fields: OverlayFields,
): Promise<void> {
  validateOverlayFields(fields);
  const supabase = createAdminSupabase();
  // The category is re-checked against this user before the insert: category_id
  // arrives from the client, and the admin client would otherwise happily
  // attach an overlay to another tenant's category.
  const { data: cat } = await supabase
    .from("categories").select("id").eq("id", categoryId).eq("user_id", userId).maybeSingle();
  if (!cat) throw new Error("unknown category");

  const { error } = await supabase.from("category_overlays").insert({
    user_id: userId, category_id: categoryId, ...fields,
  });
  if (error) throw new Error(error.message);
}

export async function updateOverlayForUser(
  userId: string, id: string, fields: OverlayFields,
): Promise<void> {
  validateOverlayFields(fields);
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("category_overlays")
    .update(fields).eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function deleteOverlayForUser(userId: string, id: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("category_overlays")
    .delete().eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}
