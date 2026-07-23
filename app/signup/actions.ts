"use server";
import { createServerSupabase } from "@/lib/supabase/server";
import { checkInviteCode } from "@/lib/auth/invite";

export async function signUp(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const invite = String(formData.get("invite") ?? "");

  if (!checkInviteCode(invite)) return { error: "Invalid invite code." };
  if (!email || password.length < 8) {
    return { error: "Enter an email and a password of at least 8 characters." };
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: error.message };
  return {};
}
