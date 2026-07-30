import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getKeyStatus } from "@/lib/settings/user-secrets";
import { FormatsManager } from "./formats-manager";
import type { Format } from "@/lib/types";

export default async function FormatsPage() {
  const user = await requireUser();
  const supabase = await createServerSupabase();
  // RLS returns shared rows plus this tenant's own; split them here because
  // shared rows cannot be edited through the app at all.
  const { data } = await supabase
    .from("formats").select("*").order("created_at", { ascending: false });
  const all = (data ?? []) as Format[];
  const keys = await getKeyStatus(user.id);

  return (
    <FormatsManager
      own={all.filter((f) => f.user_id === user.id)}
      shared={all.filter((f) => f.user_id !== user.id)}
      hasAnthropicKey={keys.anthropic}
    />
  );
}
