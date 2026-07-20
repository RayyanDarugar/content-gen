import { createServerSupabase } from "@/lib/supabase/server";
import { ConfigForm } from "./config-form";
import type { Category } from "@/lib/types";

export default async function ConfigPage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase.from("categories").select("*").order("key");
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Config</h1>
      {((data ?? []) as Category[]).map((c) => <ConfigForm key={c.key} category={c} />)}
    </div>
  );
}
