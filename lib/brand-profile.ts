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

export async function saveBrandProfileForUser(userId: string, fields: BrandProfileFields): Promise<void> {
  if (!fields.business_name.trim()) throw new Error("Give the brand a name.");
  const supabase = createAdminSupabase();
  // business_name is stored trimmed, not as supplied: the form path already
  // trims, but the MCP `update_brand_profile` tool passes model-authored text
  // straight through, and a name that only *validates* after trimming must
  // also *persist* trimmed or the two callers disagree about the stored value.
  const { error } = await supabase.from("brand_profiles").upsert(
    { user_id: userId, ...fields, business_name: fields.business_name.trim() },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(error.message);
}
