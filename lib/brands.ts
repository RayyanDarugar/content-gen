import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { BrandProfile } from "@/lib/types";

// Every resolution below runs against a list that was fetched for one user.
// That is what makes cross-tenant selection structurally impossible rather
// than a check somebody has to remember: a brand id or name belonging to
// another account is simply not in the array being searched.

export function pickDefaultBrand(brands: BrandProfile[]): BrandProfile | null {
  if (brands.length === 0) return null;
  return (
    brands.find((b) => b.is_default) ??
    [...brands].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
  );
}

// The MCP resolution rule (spec §6). There is deliberately no
// default-on-ambiguity path: silently picking a brand when several exist
// would reinstate the exact bug this project removes, on the surface where a
// human is least likely to notice it.
export function resolveBrandByName(brands: BrandProfile[], name?: string): BrandProfile {
  if (brands.length === 0) {
    throw new Error("This account has no brands yet — set one up in the app before calling this tool.");
  }
  const names = brands.map((b) => b.business_name).join(", ");
  if (!name?.trim()) {
    if (brands.length === 1) return brands[0];
    throw new Error(`This account has ${brands.length} brands. Pass brand explicitly — one of: ${names}`);
  }
  const wanted = name.trim().toLowerCase();
  const match = brands.find((b) => b.business_name.trim().toLowerCase() === wanted);
  if (!match) throw new Error(`No brand named "${name}". Available: ${names}`);
  return match;
}

export async function listBrandsForUser(userId: string): Promise<BrandProfile[]> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("brand_profiles").select("*").eq("user_id", userId).order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as BrandProfile[];
}
