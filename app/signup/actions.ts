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
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: error.message };

  if (!data.session) {
    // signUp succeeded but didn't establish a session — either email
    // confirmation is still required on this Supabase project, or this
    // email is already registered (Supabase returns no error either way,
    // to avoid leaking which). Try signing in directly: succeeds if the
    // account is actually usable, gives a clear error if not, instead of
    // a silent false "success" that redirects to an unauthenticated page.
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) return { error: signInError.message };
  }

  return {};
}
