import { createServerSupabase } from "@/lib/supabase/server";
import { GenerateForm } from "./generate-form";
import type { Category } from "@/lib/types";

export default async function GeneratePage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("categories").select("key,name").eq("active", true).order("key");
  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-2xl font-bold">Generate ideas</h1>
      <GenerateForm categories={(data ?? []) as Pick<Category, "key" | "name">[]} />
    </div>
  );
}
