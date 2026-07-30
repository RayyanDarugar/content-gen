import "server-only";
import { randomBytes, createHash } from "crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";

const TOKEN_PREFIX = "cga_"; // content-gen-app

export function generateApiToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createApiTokenForUser(
  userId: string,
  label: string,
): Promise<{ id: string; token: string }> {
  const { token, hash } = generateApiToken();
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("api_tokens")
    .insert({ user_id: userId, label: label.trim() || "Untitled token", token_hash: hash })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "failed to create token");
  return { id: data.id as string, token };
}

export async function verifyApiToken(token: string): Promise<{ userId: string; tokenId: string } | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const supabase = createAdminSupabase();
  const hash = hashToken(token);
  const { data, error } = await supabase
    .from("api_tokens")
    .select("id, user_id")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error || !data) return null;
  // Best-effort — a failed last_used_at write must never fail authentication.
  await supabase.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return { userId: data.user_id as string, tokenId: data.id as string };
}

export async function listApiTokensForUser(userId: string) {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("api_tokens")
    .select("id, label, created_at, last_used_at") // never token_hash
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function revokeApiTokenForUser(userId: string, tokenId: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("api_tokens").delete().eq("id", tokenId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}
