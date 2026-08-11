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

  // Columns enumerated explicitly, never spread from `fields`. These
  // functions are reachable from a "use server" action, where arguments
  // arrive as deserialized JSON and the TypeScript shape is erased — a
  // trailing `...fields` would let a caller-supplied `category_id` override
  // the ownership check above, since a later spread wins in an object
  // literal. Same reasoning and same shape as lib/category-mutations.ts.
  const { error } = await supabase.from("category_overlays").insert({
    user_id: userId,
    category_id: categoryId,
    name: fields.name,
    image_url: fields.image_url,
    is_slot: fields.is_slot,
    roles: fields.roles,
    corner: fields.corner,
    margin_pct: fields.margin_pct,
    size_pct: fields.size_pct,
    opacity: fields.opacity,
    shape: fields.shape,
    border_width_pct: fields.border_width_pct,
    border_color: fields.border_color,
    tint: fields.tint,
    tint_color: fields.tint_color,
    shadow: fields.shadow,
    sort_order: fields.sort_order,
    active: fields.active,
  });
  if (error) throw new Error(error.message);
}

export async function updateOverlayForUser(
  userId: string, id: string, fields: OverlayFields,
): Promise<void> {
  validateOverlayFields(fields);
  const supabase = createAdminSupabase();
  // Enumerated, not spread — and note the .eq() calls scope WHICH row is
  // updated, never WHAT is written. Spreading `fields` would carry whatever
  // keys the runtime object happens to have: a Task 7 edit form pre-filled
  // from the existing record would ride `id`, `user_id`, `category_id` and
  // the timestamps straight into the SET clause, with no malice required.
  const { error } = await supabase.from("category_overlays").update({
    name: fields.name,
    image_url: fields.image_url,
    is_slot: fields.is_slot,
    roles: fields.roles,
    corner: fields.corner,
    margin_pct: fields.margin_pct,
    size_pct: fields.size_pct,
    opacity: fields.opacity,
    shape: fields.shape,
    border_width_pct: fields.border_width_pct,
    border_color: fields.border_color,
    tint: fields.tint,
    tint_color: fields.tint_color,
    shadow: fields.shadow,
    sort_order: fields.sort_order,
    active: fields.active,
  }).eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function deleteOverlayForUser(userId: string, id: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("category_overlays")
    .delete().eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}
