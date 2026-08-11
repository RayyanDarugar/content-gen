import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { CategoryOverlay } from "@/lib/types";

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
