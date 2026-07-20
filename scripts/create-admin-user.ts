import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

async function main() {
  const email = process.env.ALLOWED_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email) throw new Error("ALLOWED_EMAIL is not set in .env.local");
  if (!password) throw new Error("ADMIN_PASSWORD is not set in .env.local");

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: listData, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw new Error(`Failed to list users: ${listError.message}`);

  const existing = listData.users.find((u) => u.email === email);

  if (existing) {
    const { error: updateError } = await supabase.auth.admin.updateUserById(existing.id, {
      password,
    });
    if (updateError) throw new Error(`Failed to update user: ${updateError.message}`);
  } else {
    const { error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError) throw new Error(`Failed to create user: ${createError.message}`);
  }

  console.log(`Admin user ready: ${email}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
