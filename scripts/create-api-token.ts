import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createApiTokenForUser } from "../lib/auth/api-tokens";

// Mints an MCP API token for an existing user. There is no token UI — this
// script is the supported way to create one (see docs/mcp-agent-integration.md).
//
// Run it with `npm run create-api-token -- <email> [label]`, which sets
// --conditions=react-server so `import "server-only"` inside lib/auth/api-tokens
// resolves to the package's empty stub instead of its throwing entrypoint.
// Point .env.local at whichever environment (local or deployed) you want the
// token to work against — the token is stored in that project's Supabase.
async function main() {
  const email = process.argv[2];
  const label = process.argv[3] || "Claude Code MCP";
  if (!email) throw new Error("Usage: npm run create-api-token -- <user-email> [label]");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`Failed to list users: ${error.message}`);
  const user = data.users.find((u) => u.email === email);
  if (!user) throw new Error(`No user with email ${email}`);

  // Reuses the app's own minting path so the prefix and the sha256 hash stored
  // in api_tokens can never drift from what verifyApiToken expects.
  const { token } = await createApiTokenForUser(user.id, label);

  console.log(`Token for ${email} ("${label}") — shown once, store it now:\n`);
  console.log(token);
  console.log(`\nThere is no token UI yet — to revoke, delete this token's row from the api_tokens table.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
