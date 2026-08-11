import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { BrandContext } from "@/lib/athena/prompts";

export async function loadBrandContext(brandId: string): Promise<BrandContext> {
  const supabase = createAdminSupabase();
  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").eq("id", brandId).maybeSingle();
  return {
    business_name: brandRow?.business_name ?? "",
    business_description: brandRow?.business_description ?? "",
    audience: brandRow?.audience ?? "",
    voice: brandRow?.voice ?? "",
    avoid: brandRow?.avoid ?? "",
    proof_points: brandRow?.proof_points ?? [],
    standing: brandRow?.standing ?? [],
    colors: brandRow?.colors ?? [],
    fonts: brandRow?.fonts ?? [],
    visual_notes: brandRow?.visual_notes ?? "",
  };
}
