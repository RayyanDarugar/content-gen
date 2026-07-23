// scripts/verify-isolation.ts
// Verifies RLS: two users each see only their own categories.
// Run against the dev Supabase after migration 0005 is applied.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function makeUser(email: string) {
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.createUser({
    email, password: "test-password-123", email_confirm: true,
  });
  if (error && !error.message.includes("already been registered")) throw error;
  // fetch id if it already existed
  const id = data?.user?.id ?? (await admin.auth.admin.listUsers()).data.users
    .find((u) => u.email === email)!.id;
  // seed one category for this user via service role
  await admin.from("categories").insert({
    user_id: id, key: `k_${id.slice(0, 8)}`, name: "test",
  });
  return { id, email };
}

async function sessionClient(email: string) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: "test-password-123" });
  if (error) throw error;
  return c;
}

async function main() {
  const a = await makeUser("iso-a@example.com");
  const b = await makeUser("iso-b@example.com");
  const ca = await sessionClient(a.email);
  const cb = await sessionClient(b.email);
  const { data: aRows } = await ca.from("categories").select("user_id");
  const { data: bRows } = await cb.from("categories").select("user_id");
  const aOnlyOwn = (aRows ?? []).every((r) => r.user_id === a.id);
  const bOnlyOwn = (bRows ?? []).every((r) => r.user_id === b.id);
  console.log("A sees", aRows?.length, "rows, all own:", aOnlyOwn);
  console.log("B sees", bRows?.length, "rows, all own:", bOnlyOwn);
  if (!aOnlyOwn || !bOnlyOwn || !aRows?.length || !bRows?.length) {
    throw new Error("ISOLATION FAILED — a user can see another user's rows");
  }
  console.log("ISOLATION OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
