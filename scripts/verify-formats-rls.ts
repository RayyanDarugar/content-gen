// scripts/verify-formats-rls.ts
// Verifies the formats RLS policies from migration 0017. Unlike every other
// table here, formats is NOT pure owner-isolation: a shared row is readable
// by every tenant. Run against dev Supabase after 0017 is applied.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const PASSWORD = "test-password-123";

async function makeUser(email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error && !error.message.includes("already been registered")) throw error;
  const id = data?.user?.id ?? (await admin.auth.admin.listUsers()).data.users
    .find((u) => u.email === email)!.id;
  return { id, email };
}

async function sessionClient(email: string) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return c;
}

// Seeds via service role, which bypasses RLS — that is the point: we need a
// shared row to exist, and no app-level client is allowed to create one.
async function seedFormat(userId: string, name: string, shared: boolean) {
  const { data, error } = await admin.from("formats").insert({
    user_id: userId, name, structure: "s", origin: "observed", shared,
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

const failures: string[] = [];
function check(label: string, pass: boolean) {
  console.log(pass ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!pass) failures.push(label);
}

async function main() {
  const a = await makeUser("fmt-a@example.com");
  const b = await makeUser("fmt-b@example.com");
  await admin.from("formats").delete().in("user_id", [a.id, b.id]);

  const aPrivate = await seedFormat(a.id, "a-private", false);
  const aShared = await seedFormat(a.id, "a-shared", true);
  const bPrivate = await seedFormat(b.id, "b-private", false);

  const ca = await sessionClient(a.email);
  const cb = await sessionClient(b.email);

  const { data: bSees } = await cb.from("formats").select("id");
  const bIds = new Set((bSees ?? []).map((r) => r.id as string));

  check("1. B cannot read A's unshared format", !bIds.has(aPrivate));
  check("2. B CAN read A's shared format", bIds.has(aShared));
  check("2b. B can still read its own format", bIds.has(bPrivate));

  const ins = await cb.from("formats").insert({
    user_id: b.id, name: "sneaky", structure: "s", origin: "observed", shared: true,
  });
  check("3. A tenant cannot insert shared = true", ins.error !== null);

  const upd = await cb.from("formats").update({ shared: true }).eq("id", bPrivate).select("id");
  check("4. A tenant cannot update a row to shared = true",
    upd.error !== null || (upd.data ?? []).length === 0);

  const updShared = await ca.from("formats")
    .update({ name: "renamed" }).eq("id", aShared).select("id");
  check("5. Nobody can update an already-shared row through the app",
    updShared.error !== null || (updShared.data ?? []).length === 0);

  const { data: bLogs } = await cb.from("format_suggestions").select("id");
  const { error: logInsErr } = await admin.from("format_suggestions")
    .insert({ user_id: a.id, concept: "a-log" });
  if (logInsErr) throw logInsErr;
  const { data: bLogsAfter } = await cb.from("format_suggestions").select("id");
  check("6. B cannot read A's format_suggestions",
    (bLogsAfter ?? []).length === (bLogs ?? []).length);

  await admin.from("format_suggestions").delete().in("user_id", [a.id, b.id]);
  await admin.from("formats").delete().in("user_id", [a.id, b.id]);

  if (failures.length) throw new Error(`FORMATS RLS FAILED:\n- ${failures.join("\n- ")}`);
  console.log("FORMATS RLS OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
