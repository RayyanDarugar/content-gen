# Multi-Tenant "Friends Beta" — Design Spec

**Date:** 2026-07-22
**Status:** Approved direction; pending final user review
**Branch/worktree:** `multi-tenant` at `.worktrees/multi-tenant`, pointed at a fresh Supabase project (`ahxuentgbvfuigiiubpz`), migrations 0001–0004 already replayed.
**Builds on:** The shipped single-tenant Content Engine (Phases 1–3 + redesign). This spec transforms it into a self-serve, multi-tenant app for a small closed beta.

## 1. Summary

Turn the single-user Content Engine into a self-serve multi-tenant app that a handful of invited friends/connections can use for their own businesses, to validate whether the product is worth pursuing. Each user signs up with an invite code, brings their own Anthropic + Kie.ai API keys (BYOK), defines their own brand and content categories, connects their own Buffer account via OAuth, and runs the same generate → review → image → post pipeline in isolation from every other user.

The beta ships as a **separate parallel deployment** — a new Vercel project on the new Supabase database. The existing Athena deployment keeps running untouched; Rayyan signs up on the beta as an ordinary user. There is **no data migration** from the old app.

**Explicitly out of scope** (deferred; see §13): billing/Stripe/usage metering, the concierge paid tier as software, teams/multiple-users-per-account, admin tooling, a public marketing site, and AI-assisted style-guide drafting.

## 2. Key decisions (locked during brainstorming)

- **Deployment:** separate parallel deployment; no cutover, no data-migration script.
- **Tenancy:** user-scoped, not org-scoped. `user_id` on every domain table; RLS is `auth.uid() = user_id`. No organizations or memberships tables. Each signup is its own isolated tenant. (Teams later = a mechanical migration then; YAGNI now.)
- **Image hosting:** app-owned shared Cloudinary (existing account/env), not per-user. BYOK is reserved for the metered/expensive services only.
- **BYOK scope:** Anthropic + Kie.ai keys per user. Cloudinary shared. `CLAUDE_MODEL` stays an app-level env default.
- **Key storage:** application-level AES-256-GCM encryption with a master key in env; decrypt server-side at call time.
- **Onboarding:** an in-app Setup page showing live connection status, plus a written external how-to doc.
- **Invite gate:** signup requires an invite code (`INVITE_CODE` env, initial value `supercontent2026`).

## 3. Architecture

```
Next.js 16 (App Router) on a NEW Vercel project
├─ Auth: Supabase email+password, self-serve signup gated by invite code
│    (no email allowlist; any signed-up user is a valid tenant)
├─ Tenancy: every domain row carries user_id; RLS = auth.uid() = user_id
├─ Per-user secrets (AES-256-GCM encrypted): Anthropic key, Kie key,
│    Buffer OAuth access/refresh tokens
├─ Shared app services (app env, not per-user): Cloudinary, CLAUDE_MODEL,
│    Buffer App Client id/secret, encryption master key, invite code
├─ Pages: /signup /login /setup /config /generate /ideas /gallery /post
├─ API/routes:
│    POST /api/ideas/generate    → Claude, using caller's Anthropic key
│    POST /api/images/generate   → Kie submit, using caller's Kie key
│    GET  /api/jobs/poll         → global cron; per-generation looks up the
│                                   owning user's Kie key; ingest → shared Cloudinary
│    POST /api/posts/create      → Buffer post, using caller's Buffer token
│    GET  /auth/buffer           → begin Buffer OAuth (PKCE)
│    GET  /auth/buffer/callback  → exchange code, store encrypted tokens
└─ New Supabase project (Postgres + Auth + Realtime + shared Cloudinary for storage)
```

The global poll cron remains a single endpoint authed by `CRON_SECRET`. It iterates all pending generations across all users; for each, it looks up the owning user's decrypted Kie key to poll Kie, and ingests the finished image to the **shared** Cloudinary (so ingest needs no per-user storage credentials).

## 4. Data model changes

All new/changed tables follow the existing conventions (`id uuid pk`, `created_at`, `updated_at`, `set_updated_at()` trigger where applicable). Delivered as migration **`0005_multi_tenant.sql`** (plus any follow-ups the plan splits out).

### 4.1 `user_id` on existing tables
Add `user_id uuid not null references auth.users(id) on delete cascade` to: `categories`, `ideas`, `generations`, `posts`, `post_images`. Index `user_id` on each.

### 4.2 RLS rewrite
Drop the old policies: the `0001` "auth full access" policies and the `0002` email-scoped policies (and migration 0002's helper if present). Replace on every domain table with:

```sql
create policy "owner read"   on <t> for select to authenticated using (auth.uid() = user_id);
create policy "owner write"  on <t> for all    to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Server API routes continue to use the service-role client for privileged work (cron, cross-cutting writes) and must **explicitly filter by the acting user's id** — RLS is the backstop, not the only guard.

### 4.3 `user_settings` (secrets, 1:1 with user)
| column | type | notes |
|---|---|---|
| user_id | uuid pk references auth.users(id) on delete cascade | |
| anthropic_key_enc | text | AES-256-GCM ciphertext (iv+tag+data), nullable until set |
| kie_key_enc | text | same |
| buffer_access_token_enc | text | nullable until Buffer connected |
| buffer_refresh_token_enc | text | |
| buffer_token_expires_at | timestamptz | for refresh scheduling |
| buffer_connected_at | timestamptz | null = not connected |

RLS owner-only. Encrypted columns are never returned to the client — only server code decrypts them.

### 4.4 `brand_profiles` (non-secret brand context, 1:1 with user)
| column | type | notes |
|---|---|---|
| user_id | uuid pk references auth.users(id) on delete cascade | |
| business_name | text default '' | |
| business_description | text default '' | who the business is / what it does |
| audience | text default '' | target audience |
| voice | text default '' | tone / voice |
| avoid | text default '' | "never lead with…" style guardrails |

Replaces the hardcoded Athena brand block in `lib/athena/prompts.ts`.

### 4.5 `categories` changes
- **Add** `output_format text not null default ''` — free-text description of how ideas in this category should be structured (replaces the hardcoded per-key branches like COMIC=panels, SAT_MYTH=myth/scene/insight).
- **Drop** `buffer_account` (the 1|2 selector for Rayyan's two personal accounts).
- **Keep** `buffer_channel_id` — now populated from the user's OAuth-connected Buffer channels via the config dropdown.
- Categories are fully user-managed CRUD (create/edit/delete any number); the "5 fixed seeded slots" assumption is gone. No seeding on signup — a new user starts with zero categories and creates their own.

### 4.6 `usage_counters` (soft caps)
| column | type | notes |
|---|---|---|
| user_id | uuid references auth.users(id) on delete cascade | |
| period | text | month key, e.g. `2026-07` |
| ideas_count | int not null default 0 | |
| images_count | int not null default 0 | |

Unique `(user_id, period)`. Incremented via upsert on idea-gen and image-submit; checked against env-configured defaults before the operation.

## 5. Auth & signup

- **`/signup`** (public): email, password, invite code. A server action verifies the code equals `INVITE_CODE` (env), then `supabase.auth.signUp`. On success the user is a tenant immediately — no org record needed. Wrong/missing code → friendly rejection, no account created.
- **`/login`**: unchanged flow; remove the "email not allowed" rejection path.
- **Middleware:** replace the `ALLOWED_EMAIL` comparison with "authenticated ⇒ allowed." Unauthenticated users hitting protected routes still redirect to `/login`; `/signup` joins `/login` and `/auth` as public.
- **Auth helper:** `requireAllowedUser()` → `requireUser()` returning the current user (or throwing). All call sites updated.
- **Email confirmation: disabled for the beta.** The invite code is the trust gate; requiring email verification would reintroduce a dependency on working transactional email, which has never worked on this project (Phase 1 abandoned magic-link for exactly this reason). A closed invite beta doesn't need it. This is a Supabase project setting (§12), so signup is immediate on valid code + credentials. Password reset is Supabase-native and out of scope to build UI for in this pass.

## 6. BYOK keys + encryption

- **Encryption module** (`lib/crypto/secrets.ts`): AES-256-GCM. `encryptSecret(plaintext)` returns a compact string encoding `iv | authTag | ciphertext`; `decryptSecret(blob)` reverses it. Master key from env `SECRETS_ENC_KEY` (32 bytes, base64). Pure, unit-testable (round-trip, tamper-detection).
- **Key config** lives on the Config/Setup surface: fields to paste Anthropic + Kie keys; on save they're encrypted and written to `user_settings`. The UI shows only "set / not set" (never echoes stored keys). Optional lightweight "test key" check deferred unless trivial.
- **Refactor key reads:** every current `process.env` read for a BYOK service becomes a per-user decrypted lookup:
  - `generate-ideas.ts`: `new Anthropic({ apiKey: <user anthropic key> })`.
  - `kie.ts`: Kie calls take the user's key (submit **and** the cron's poll path).
  - `CLOUDINARY_*` stay app env (shared). `CLAUDE_MODEL` stays app env.
- **Cron key lookup:** the poll route resolves each pending generation's owning `user_id`, decrypts that user's Kie key, and uses it for the `recordInfo` poll. Ingest uploads to the shared Cloudinary as today.
- **Missing keys:** generation endpoints reject with a clear "add your API keys in Setup" message before calling out. A user can't reach the submit/poll path without a Kie key.

## 7. Brand context + generic prompts

`lib/athena/prompts.ts` is genericized:
- `buildIdeaSystemPrompt` takes the user's `brand_profiles` fields + their categories (each with `style_guide` and `output_format`) and composes the brand rules and per-category structure dynamically — no Athena/Beagle/SAT literals.
- The per-category output structure comes from each category's `output_format` field instead of hardcoded key branches.
- `FILTER_SYSTEM_PROMPT` becomes a function taking brand context (brand-alignment check generalized from "Athena teacher-not-AI" to the user's own brand + avoid list).
- `prompts.test.ts` is rewritten to assert the generic builder injects provided brand/category context (and omits it gracefully when empty), replacing the Athena-specific assertions.

## 8. Category management

- Full CRUD UI on `/config`: add a category (name, style guide, output format, style-ref image, images-per-carousel, aspect ratio, Buffer channel), edit, delete, active toggle.
- `buffer_channel_id` is chosen from a dropdown of the user's connected Buffer channels (see §9); empty/disconnected shows a "connect Buffer to pick a channel" state.
- No fixed category keys; `key` is user-supplied or slugified from the name, unique per user.

## 9. Buffer OAuth + channel picker

- **One-time app setup (Rayyan):** register a Buffer **App Client** (confidential — has a client secret), redirect URI `<beta-domain>/auth/buffer/callback`, requesting scopes `posts:read`, `posts:write`, `account:read`, `offline_access`. `client_id`/`client_secret` become app env.
- **Connect flow:** `/auth/buffer` generates a PKCE `code_verifier` (stored in a short-lived httpOnly cookie) + `code_challenge`, redirects to `https://auth.buffer.com/auth`. `/auth/buffer/callback` exchanges the code at `https://auth.buffer.com/token` (auth-code + PKCE + client secret), receives access + refresh tokens, encrypts and stores them in `user_settings`, sets `buffer_connected_at`.
- **Channel list:** using the `account:read` scope, fetch the user's connected channels for the config dropdown (names shown, channel id stored on the category).
- **Token refresh:** before a Buffer call, if `buffer_token_expires_at` is past, refresh via the refresh token (`offline_access`) and re-store. Encapsulated in a `getValidBufferToken(userId)` helper.
- **Posting:** `/api/posts/create` swaps the two hardcoded `BUFFER_TOKEN_1/2` env reads for the acting user's valid token; `buffer_account`-based routing is removed.
- **Open unknown to verify early (not a blocker):** whether a connecting user needs a paid Buffer plan. Verified by testing the connect flow with a free Buffer account during implementation; if it requires paid, that's a note in the onboarding doc, not a code change.

## 10. Style-ref image upload

- Category config gets a real file-upload control. The file is sent to the shared Cloudinary via the existing base64-data-URI upload path (the same approach that fixed the Phase 2 corruption bug), and the returned URL is stored in `categories.style_ref_url`.
- Replaces today's paste-a-URL text field. Existing style-ref behavior downstream (Kie style reference) is unchanged — it still consumes a URL.

## 11. Usage caps

- Env-configured monthly defaults, e.g. `USAGE_CAP_IDEAS`, `USAGE_CAP_IMAGES` (sensible starting values chosen in the plan).
- Before generating ideas / submitting images, check the caller's `usage_counters` row for the current month; if at/over cap, return a friendly "monthly limit reached — contact Rayyan to raise it." On success, increment via upsert.
- Soft by design: Rayyan raises a specific user's effective cap by editing their counter/period in the DB. This is a runaway-bug safety valve on someone's own key spend, not a monetization lever.

## 12. Setup page + onboarding doc

- **`/setup`**: a single page showing live status — Anthropic key set ✓/✗, Kie key set ✓/✗, Buffer connected ✓/✗, and "≥1 category with a style reference" ✓/✗ — with a "Connect Buffer" button and links into `/config`. Each item links to the relevant section of the written how-to doc.
- **Onboarding doc** (external, e.g. Google Doc/Notion; not built in-app): how to get Anthropic and Kie keys, how Buffer connection works, how to write a style guide, and how to make a first style-reference image. The Setup page links to it.

## 13. Out of scope (deferred)

Billing/Stripe/usage metering; the concierge paid tier as software (handled manually — Rayyan drops his own key in for a user's row); teams / multiple users per account; admin/observability tooling; public marketing/landing site; AI-assisted style-guide drafting; password-reset UI; in-app "test this API key" checks (unless trivial).

## 14. Manual setup steps (Rayyan, outside code)

1. New Vercel project connected to the `multi-tenant` branch (or a beta branch), with env: new Supabase URL/anon/service keys, shared `CLOUDINARY_*`, `CLAUDE_MODEL`, `CRON_SECRET`, `SECRETS_ENC_KEY` (generate: `openssl rand -base64 32`), `INVITE_CODE`, Buffer `BUFFER_CLIENT_ID`/`BUFFER_CLIENT_SECRET`, `USAGE_CAP_*`.
2. Register the Buffer App Client (confidential; scopes and redirect URI per §9).
3. Apply migration `0005` (and any splits) in the new Supabase SQL editor.
4. In the new Supabase project's Auth settings, **disable email confirmation** (§5) so invite-gated signup is immediate and doesn't depend on transactional email.
5. Point cron-job.org at the new deployment's `/api/jobs/poll` with the new `CRON_SECRET`.
6. Write the onboarding doc; put its URL in the Setup page (config/env).

## 15. Build phasing

One spec, sequenced so the foundation lands and is verified before the feature layer. The implementation plan will decompose accordingly:

- **Phase A — Foundation (must land + be tested first):** migration `0005` (user_id + RLS rewrite + new tables), signup + invite gate, middleware/auth-helper rework. Verify isolation on the fresh Supabase (two test users can't see each other's rows).
- **Phase B — BYOK + generation:** encryption module, key config, refactor Anthropic/Kie reads (incl. cron), brand context + generic prompts, category CRUD, style-ref upload.
- **Phase C — Buffer OAuth:** connect flow, channel picker, token refresh, posting swap.
- **Phase D — Polish:** usage caps, Setup page.

"Minimum usable" for a first friend = A + B + C. Phase D can follow a first real-world test.

## 16. Testing / verification

- Unit tests (vitest, existing harness): encryption round-trip + tamper detection; generic prompt builder with/without brand context; usage-cap check logic; Buffer token-refresh decision logic; PKCE challenge derivation.
- Genericized `prompts.test.ts` replaces the Athena-specific assertions.
- Manual multi-tenant isolation check on the fresh Supabase: two signups, confirm RLS blocks cross-user reads.
- Buffer connect verified end-to-end with a real (ideally free-tier) Buffer account during Phase C.
- Existing pipeline behavior (idea → filter → image → gallery → post) re-verified per-user once keys/brand/categories are user-supplied.
