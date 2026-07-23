import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getKeyStatus } from "@/lib/settings/user-secrets";
import { getBufferStatus } from "@/lib/settings/buffer";
import { CategoryManager } from "./category-manager";
import { KeysSection } from "./keys-section";
import { BrandSection } from "./brand-section";
import { BufferSection } from "./buffer-section";
import type { BrandProfile, Category } from "@/lib/types";

export default async function ConfigPage() {
  const user = await requireUser();
  const status = await getKeyStatus(user.id);
  const bufferStatus = await getBufferStatus(user.id);
  const supabase = await createServerSupabase();
  const { data } = await supabase.from("categories").select("*").order("key");
  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").maybeSingle();
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Config</h1>
      <KeysSection status={status} />
      <BrandSection brand={(brandRow as BrandProfile) ?? null} />
      <BufferSection connected={bufferStatus.connected} />
      <CategoryManager categories={(data ?? []) as Category[]} />
    </div>
  );
}
