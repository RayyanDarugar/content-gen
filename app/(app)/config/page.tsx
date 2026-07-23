import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getKeyStatus } from "@/lib/settings/user-secrets";
import { ConfigForm } from "./config-form";
import { KeysSection } from "./keys-section";
import type { Category } from "@/lib/types";

export default async function ConfigPage() {
  const user = await requireUser();
  const status = await getKeyStatus(user.id);
  const supabase = await createServerSupabase();
  const { data } = await supabase.from("categories").select("*").order("key");
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Config</h1>
      <KeysSection status={status} />
      {((data ?? []) as Category[]).map((c) => <ConfigForm key={c.key} category={c} />)}
    </div>
  );
}
