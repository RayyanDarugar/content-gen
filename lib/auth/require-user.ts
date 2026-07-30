import "server-only";
import type { User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { verifyApiToken } from "@/lib/auth/api-tokens";

// A request-scoped MCP caller has no Supabase session — only an id. Every
// existing call site only ever reads `.id`, so a minimal stub satisfies the
// User type without pretending to have a real Supabase auth session.
function stubUser(id: string): User {
  return { id, app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "" } as User;
}

export async function requireUser(request?: NextRequest): Promise<User> {
  const bearer = request?.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) {
    const verified = await verifyApiToken(bearer.slice("Bearer ".length));
    if (!verified) throw new Error("unauthorized");
    return stubUser(verified.userId);
  }
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");
  return user;
}
