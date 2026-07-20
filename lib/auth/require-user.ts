import "server-only";
import { createServerSupabase } from "@/lib/supabase/server";

export async function requireAllowedUser() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
  const actual = user?.email?.trim().toLowerCase();
  if (!user || !allowed || actual !== allowed) {
    throw new Error("unauthorized");
  }
  return user;
}
