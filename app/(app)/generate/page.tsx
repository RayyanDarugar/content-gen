import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { GenerateForm } from "./generate-form";
import type { Category } from "@/lib/types";

export default async function GeneratePage() {
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("categories").select("key,name")
    .eq("brand_id", brand.id).eq("active", true).order("key");
  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-2xl font-bold">Generate ideas</h1>
      <GenerateForm categories={(data ?? []) as Pick<Category, "key" | "name">[]} />
    </div>
  );
}
