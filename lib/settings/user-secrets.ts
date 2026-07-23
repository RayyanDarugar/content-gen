import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto/secrets";

interface SettingsRow { anthropic_key_enc: string; kie_key_enc: string; }

async function fetchRow(userId: string): Promise<SettingsRow | null> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("user_settings")
    .select("anthropic_key_enc, kie_key_enc")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_settings query failed: ${error.message}`);
  return (data as SettingsRow) ?? null;
}

export async function requireAnthropicKey(userId: string): Promise<string> {
  const row = await fetchRow(userId);
  if (!row?.anthropic_key_enc) throw new Error("Add your Anthropic API key in Config");
  return decryptSecret(row.anthropic_key_enc);
}

export async function requireKieKey(userId: string): Promise<string> {
  const row = await fetchRow(userId);
  if (!row?.kie_key_enc) throw new Error("Add your Kie.ai API key in Config");
  return decryptSecret(row.kie_key_enc);
}

export async function getKieKeyOrNull(userId: string): Promise<string | null> {
  const row = await fetchRow(userId);
  if (!row?.kie_key_enc) return null;
  return decryptSecret(row.kie_key_enc);
}

export async function getKeyStatus(userId: string): Promise<{ anthropic: boolean; kie: boolean }> {
  const row = await fetchRow(userId);
  return { anthropic: !!row?.anthropic_key_enc, kie: !!row?.kie_key_enc };
}
