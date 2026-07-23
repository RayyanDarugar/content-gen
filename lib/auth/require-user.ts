import "server-only";
import type { User } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase/server";

export async function requireUser(): Promise<User> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

// Temporary shim so existing call sites keep building while they are migrated
// to requireUser across Tasks 6–9. Removed in Task 9.
export async function requireAllowedUser(): Promise<User> {
  return requireUser();
}
