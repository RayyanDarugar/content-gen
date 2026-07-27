// One-time migration: copy the original single-tenant Athena data out of the
// legacy Supabase project into the multi-tenant project, owned by one user.
//
//   npm run import-legacy              # dry run, reports what it would write
//   npm run import-legacy -- --execute # actually writes
//
// Source credentials come from .env.local, destination from LEGACY_DEST_ENV
// (defaults to the multi-tenant worktree's .env.local).
//
// Original row ids are preserved, so foreign keys survive the move untouched
// and re-running is idempotent (every write is an upsert keyed on id).
//
// Not migrated: the legacy Storage bucket. Four of its five objects are
// debug artifacts, and every style ref plus 29 of 30 succeeded generations
// already point at Cloudinary, whose URLs are project-independent.
import { config } from "dotenv";
import { readFileSync } from "fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const TARGET_USER = process.env.LEGACY_TARGET_USER ?? "4e380d19-990d-499e-9d4a-c3759b678d14";
const DEST_ENV = process.env.LEGACY_DEST_ENV ?? ".worktrees/multi-tenant/.env.local";
const EXECUTE = process.argv.includes("--execute");

// The legacy brand lived only in prompts.ts as hardcoded strings, never in a
// table. Transcribed here so it survives as data. Edit on /config afterwards.
const ATHENA_BRAND = {
  business_name: "Athena",
  business_description:
    "An SAT prep platform that works like a personalized teacher — never an AI product, " +
    "dashboard, or analytics tool. The core outcome is the moment a student says " +
    '"Ohhhh... now I get it." Mascot is a cute Beagle dog: curious, friendly, slightly ' +
    "goofy. The Beagle is always the guide or the student in content, never the product.",
  audience:
    "Parents aged 35-55 worried about SAT scores, college admissions, tutoring costs, and " +
    "their kid feeling stuck. Secondary: high-school students who feel stuck.",
  voice:
    "Warm and plain-spoken, like a good teacher rather than a tech company. Concrete over " +
    "abstract. Fresh takes, never tired SAT-prep clichés.",
  avoid:
    "AI-powered, adaptive learning, algorithms, analytics, dashboards. Never position Athena " +
    "as software instead of a teacher. No tired SAT prep clichés.",
};

function parseEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function readAll(db: SupabaseClient, table: string) {
  const { data, error } = await db.from(table).select("*");
  if (error) throw new Error(`read ${table} failed: ${error.message}`);
  return data ?? [];
}

async function upsert(
  db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
) {
  if (!rows.length) return;
  const { error } = await db.from(table).upsert(rows, { onConflict });
  if (error) throw new Error(`write ${table} failed: ${error.message}`);
}

async function main() {
  const destEnv = parseEnv(DEST_ENV);
  const src = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const dest = createClient(
    destEnv.NEXT_PUBLIC_SUPABASE_URL,
    destEnv.SUPABASE_SERVICE_ROLE_KEY,
  );

  console.log(`mode:   ${EXECUTE ? "EXECUTE (writes)" : "DRY RUN (no writes)"}`);
  console.log(`source: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);
  console.log(`dest:   ${destEnv.NEXT_PUBLIC_SUPABASE_URL}`);
  console.log(`owner:  ${TARGET_USER}\n`);

  const { data: owner, error: ownerErr } = await dest.auth.admin.getUserById(TARGET_USER);
  if (ownerErr || !owner?.user) throw new Error(`target user not found in dest: ${ownerErr?.message}`);
  console.log(`owner resolves to ${owner.user.email}\n`);

  const [categories, ideas, generations, posts, postImages] = await Promise.all([
    readAll(src, "categories"),
    readAll(src, "ideas"),
    readAll(src, "generations"),
    readAll(src, "posts"),
    readAll(src, "post_images"),
  ]);

  // buffer_account was dropped when posting moved to per-user Buffer keys.
  // output_format is new and takes its column default.
  const catRows = categories.map(({ buffer_account: _drop, ...c }) => ({
    ...c,
    user_id: TARGET_USER,
  }));
  const ideaRows = ideas.map((r) => ({ ...r, user_id: TARGET_USER }));
  const genRows = generations.map((r) => ({ ...r, user_id: TARGET_USER }));
  const postRows = posts.map((r) => ({ ...r, user_id: TARGET_USER }));
  const postImageRows = postImages.map((r) => ({ ...r, user_id: TARGET_USER }));

  console.log("would write:");
  console.log(`  brand_profiles  1 (${ATHENA_BRAND.business_name})`);
  console.log(`  categories      ${catRows.length}  [${catRows.map((c) => c.key).join(", ")}]`);
  console.log(`  ideas           ${ideaRows.length}`);
  console.log(`  generations     ${genRows.length}`);
  console.log(`  posts           ${postRows.length}`);
  console.log(`  post_images     ${postImageRows.length}`);

  const stale = genRows.filter(
    (g) => typeof g.public_url === "string" && g.public_url.includes(".supabase.co"),
  );
  if (stale.length) {
    console.log(
      `\nwarning: ${stale.length} generation(s) point at legacy Supabase Storage and will ` +
        `404 once that project goes away:`,
    );
    for (const g of stale) console.log(`  ${g.id}  ${g.public_url}`);
  }

  if (!EXECUTE) {
    console.log("\nDry run only. Re-run with --execute to write.");
    return;
  }

  // FK order: categories before ideas/posts (composite fk on user_id+key),
  // ideas before generations, posts+generations before post_images.
  await upsert(dest, "brand_profiles", [{ user_id: TARGET_USER, ...ATHENA_BRAND }], "user_id");
  await upsert(dest, "categories", catRows, "id");
  await upsert(dest, "ideas", ideaRows, "id");
  await upsert(dest, "generations", genRows, "id");
  await upsert(dest, "posts", postRows, "id");
  await upsert(dest, "post_images", postImageRows, "id");

  console.log("\nwrote all tables. verifying...");
  for (const t of ["categories", "ideas", "generations", "posts", "post_images"]) {
    const { count, error } = await dest
      .from(t)
      .select("*", { count: "exact", head: true })
      .eq("user_id", TARGET_USER);
    console.log(`  ${t.padEnd(14)} ${error ? "ERROR: " + error.message : count} rows for owner`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
