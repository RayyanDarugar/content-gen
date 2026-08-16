import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";

// Lives here, not in app/(app)/config/actions.ts: that file is "use server",
// so exporting a userId-taking, unauthenticated function from it would publish
// it as a callable server action any unauthenticated POST could reach. Callers
// must establish the user first (requireUser() in the action wrapper, bearer
// token in the MCP route).

export interface BrandProfileFields {
  business_name: string; business_description: string; audience: string; voice: string; avoid: string;
  proof_points: string[]; standing: string[]; colors: string[]; fonts: string[]; visual_notes: string;
}

// business_name is stored trimmed, not as supplied: the form path already
// trims, but the MCP `update_brand_profile` tool passes model-authored text
// straight through, and a name that only *validates* after trimming must
// also *persist* trimmed or the two callers disagree about the stored value.
function normalize(fields: BrandProfileFields): BrandProfileFields {
  if (!fields.business_name.trim()) throw new Error("Give the brand a name.");
  return { ...fields, business_name: fields.business_name.trim() };
}

// Updates ONE brand, addressed by its own id and filtered by the owner.
// This used to upsert on user_id, which was correct only while an account
// could hold exactly one brand — with several, that upsert overwrites a
// different brand than the caller meant.
export async function saveBrandProfileForUser(
  userId: string,
  brandId: string,
  fields: BrandProfileFields,
): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from("brand_profiles").update(normalize(fields))
    .eq("id", brandId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

/**
 * Save a brand form when the account may not have a brand yet.
 *
 * /onboarding's brand step is the one place a save can arrive with nothing to
 * update: a brand-new account has zero brands. That case used to be "resolved"
 * by requireActiveBrand's redirect() — a page-only helper (see
 * lib/auth/active-brand.ts) fired from a server action, which threw
 * NEXT_REDIRECT past the action's own try/catch. The user got no error, the
 * form remounted empty, every extracted field was discarded, and nothing was
 * ever written. A save with no brand to save into is a create; say so here,
 * once, rather than making each call site remember which action to post to.
 */
export async function saveOrCreateBrandForUser(
  userId: string,
  brandId: string | null,
  fields: BrandProfileFields,
): Promise<{ brandId: string; created: boolean }> {
  if (brandId) {
    await saveBrandProfileForUser(userId, brandId, fields);
    return { brandId, created: false };
  }
  return { brandId: await createBrandForUser(userId, fields), created: true };
}

export async function createBrandForUser(
  userId: string,
  fields: BrandProfileFields,
): Promise<string> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("brand_profiles").insert({ user_id: userId, ...normalize(fields) })
    .select("id").single();
  if (error) {
    if (error.code === "23505") throw new Error("You already have a brand with that name.");
    throw new Error(error.message);
  }
  return (data as { id: string }).id;
}
