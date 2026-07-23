# Multi-Tenant Phase B — BYOK Keys + Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make idea + image generation run on each user's own encrypted API keys, brand context, and self-defined categories — so a signed-up user can fully configure their business and generate on-brand content in isolation.

**Architecture:** Store per-user Anthropic + Kie keys AES-256-GCM-encrypted in a new `user_settings` table (decrypted server-side only). Replace the hardcoded Athena brand block in `prompts.ts` with per-user `brand_profiles` context. Thread each user's decrypted key through idea generation (Anthropic), image submission + the poll cron (Kie). Cloudinary stays app-shared. Rework `/config` into a settings hub: API keys, brand profile, and full category CRUD (with image upload for style references).

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres + Auth), Node `crypto` (AES-256-GCM), `@anthropic-ai/sdk`, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-multi-tenant-beta-design.md` — governs on any conflict. Builds on the completed Phase A foundation (branch `multi-tenant`).
- **BYOK scope is Anthropic + Kie only.** Cloudinary stays app-owned (existing `CLOUDINARY_*` env, shared). `CLAUDE_MODEL` stays an app-level env default. Buffer is Phase C — do not touch Buffer columns (`buffer_account`, `buffer_channel_id`, `post_caption`) or posting code this phase.
- **Encryption:** AES-256-GCM. Master key from env `SECRETS_ENC_KEY` (32 bytes, base64). Encrypted blob format is base64 of `iv(12 bytes) || authTag(16 bytes) || ciphertext`. Decryption MUST fail (throw) on a tampered blob or wrong key — never return corrupted plaintext.
- **Encrypted key columns are never returned to the client.** They are read and decrypted only in server-side code using the service-role client. The `/config` page is a server component that computes and passes only booleans ("key set / not set") to client components.
- **Service-role clients (`createAdminSupabase`) bypass RLS** and MUST filter `.eq("user_id", userId)` on every tenant read/write (the Phase A convention). New tables get `owner all` RLS (`auth.uid() = user_id`) exactly like Phase A's domain tables.
- **Missing-key handling:** generation entry points must reject with a clear "Add your <service> API key in Config" message before calling the external API. A user with no Kie key cannot reach the submit/poll path.
- New user starts with zero categories and an empty brand profile; the generic prompt builder must degrade gracefully when brand/style fields are empty (mirror the existing `"[No style guide — fill in Config]"` placeholder behavior).
- Working dir is the worktree `.worktrees/multi-tenant` on branch `multi-tenant`. Read `node_modules/next/dist/docs/` before writing Next.js code (per AGENTS.md).
- Verification: pure logic (encryption, prompts) gets vitest tests (TDD). DB/orchestration/UI tasks verify via `npm run build` + `npm test` (suite stays green) + a stated manual check. Do not write tests that assert nothing.

## File Structure

- `lib/crypto/secrets.ts` — AES-256-GCM encrypt/decrypt (create); `tests/secrets.test.ts` (create)
- `supabase/migrations/0006_byok_brand.sql` — user_settings, brand_profiles, categories.output_format (create)
- `lib/types.ts` — `UserSettingsStatus`, `BrandProfile` types; `Category.output_format` (modify)
- `lib/settings/user-secrets.ts` — decrypt/read helpers + key status (create)
- `lib/cloudinary.ts` — shared Cloudinary upload, extracted from the poll route (create)
- `lib/athena/prompts.ts` — genericized brand/category prompts (modify); `tests/prompts.test.ts` (rewrite)
- `lib/athena/generate-ideas.ts` — per-user Anthropic key + brand context (modify)
- `lib/athena/kie.ts` — functions take an `apiKey` param (modify)
- `lib/athena/submit-generations.ts` — pass the user's Kie key (modify)
- `app/api/jobs/poll/route.ts` — per-generation Kie key lookup; use shared cloudinary (modify)
- `app/(app)/config/page.tsx` — settings hub server component (modify)
- `app/(app)/config/actions.ts` — key save, brand save, category CRUD, style-ref upload (modify)
- `app/(app)/config/keys-section.tsx`, `brand-section.tsx`, `category-manager.tsx` — client sections (create)

**Note:** `scripts/seed-categories.ts` and `scripts/create-admin-user.ts` remain Athena-legacy and untouched.

---

### Task 1: Encryption module (pure, TDD)

**Files:**
- Create: `lib/crypto/secrets.ts`
- Test: `tests/secrets.test.ts`

**Interfaces:**
- Produces: `encryptSecret(plaintext: string): string` and `decryptSecret(blob: string): string`. Later tasks store `encryptSecret(key)` and read `decryptSecret(blob)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/secrets.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";

// 32 bytes base64 for tests.
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

describe("secrets", () => {
  beforeEach(() => { process.env.SECRETS_ENC_KEY = KEY_A; });
  afterEach(() => { delete process.env.SECRETS_ENC_KEY; });

  it("round-trips a value", () => {
    const secret = "sk-ant-api03-abc123";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces different ciphertext each call (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("throws when decrypting with a different key", () => {
    const blob = encryptSecret("secret");
    process.env.SECRETS_ENC_KEY = KEY_B;
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("throws on a tampered blob", () => {
    const blob = encryptSecret("secret");
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });

  it("fails closed when SECRETS_ENC_KEY is unset", () => {
    delete process.env.SECRETS_ENC_KEY;
    expect(() => encryptSecret("x")).toThrow(/SECRETS_ENC_KEY/);
  });

  it("throws if the key is not 32 bytes", () => {
    process.env.SECRETS_ENC_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/secrets.test.ts`
Expected: FAIL — cannot resolve `@/lib/crypto/secrets`.

- [ ] **Step 3: Implement `lib/crypto/secrets.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

function masterKey(): Buffer {
  const b64 = process.env.SECRETS_ENC_KEY;
  if (!b64) throw new Error("SECRETS_ENC_KEY is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("SECRETS_ENC_KEY must decode to 32 bytes");
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = masterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const key = masterKey();
  const raw = Buffer.from(blob, "base64");
  if (raw.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/secrets.test.ts` → all PASS. Then `npm test` → full suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/crypto/secrets.ts tests/secrets.test.ts
git commit -m "feat: AES-256-GCM secret encryption module"
```

---

### Task 2: Migration 0006 + types

**Files:**
- Create: `supabase/migrations/0006_byok_brand.sql`
- Modify: `lib/types.ts`

**Interfaces:**
- Produces: `user_settings` (encrypted keys), `brand_profiles`, `categories.output_format`; `BrandProfile` type, `Category.output_format`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0006_byok_brand.sql
-- Phase B: per-user encrypted API keys, brand context, and a per-category
-- output-format field. Buffer columns are untouched (Phase C).

create table user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  anthropic_key_enc text not null default '',
  kie_key_enc text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger user_settings_updated_at before update on user_settings
  for each row execute function set_updated_at();

create table brand_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  business_name text not null default '',
  business_description text not null default '',
  audience text not null default '',
  voice text not null default '',
  avoid text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger brand_profiles_updated_at before update on brand_profiles
  for each row execute function set_updated_at();

alter table categories add column output_format text not null default '';

alter table user_settings enable row level security;
alter table brand_profiles enable row level security;

create policy "owner all" on user_settings for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner all" on brand_profiles for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

- [ ] **Step 2: USER STEP — apply the migration**

The controller must have Rayyan run `0006_byok_brand.sql` in the Supabase SQL editor before tasks that read/write these tables can be live-verified. Also confirm `SECRETS_ENC_KEY` (generate with `openssl rand -base64 32`) is added to `.env.local` in the worktree — the encryption module and every key operation need it at runtime.

- [ ] **Step 3: Add types to `lib/types.ts`**

Add `output_format: string;` to the `Category` interface (right after `style_guide`), and append:

```ts
export interface BrandProfile {
  user_id: string;
  business_name: string;
  business_description: string;
  audience: string;
  voice: string;
  avoid: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0006_byok_brand.sql lib/types.ts
git commit -m "feat: migration 0006 - user_settings, brand_profiles, categories.output_format"
```

---

### Task 3: Secret read helpers

**Files:**
- Create: `lib/settings/user-secrets.ts`

**Interfaces:**
- Consumes: `decryptSecret` (Task 1); `createAdminSupabase`.
- Produces:
  - `requireAnthropicKey(userId: string): Promise<string>` — throws `Error("Add your Anthropic API key in Config")` if unset.
  - `requireKieKey(userId: string): Promise<string>` — throws `Error("Add your Kie.ai API key in Config")` if unset.
  - `getKieKeyOrNull(userId: string): Promise<string | null>` — for the poll cron (no throw).
  - `getKeyStatus(userId: string): Promise<{ anthropic: boolean; kie: boolean }>` — for the config page.

- [ ] **Step 1: Implement `lib/settings/user-secrets.ts`**

```ts
import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto/secrets";

interface SettingsRow { anthropic_key_enc: string; kie_key_enc: string; }

async function fetchRow(userId: string): Promise<SettingsRow | null> {
  const supabase = createAdminSupabase();
  const { data } = await supabase
    .from("user_settings")
    .select("anthropic_key_enc, kie_key_enc")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as SettingsRow) ?? null;
}

export async function requireAnthropicKey(userId: string): Promise<string> {
  const row = await fetchRow(userId);
  if (!row?.anthropic_key_enc) throw new Error("Add your Anthropic API key in Config");
  return decryptSecret(row.anthropic_key_enc);
}

export async function requireKieKey(userId: string): Promise<string> {
  const row = await fetchRow(userId);
  if (!row?.kie_key_enc) throw new Error("Add your Kie.ai API key in Config");
  return decryptSecret(row.kie_key_enc);
}

export async function getKieKeyOrNull(userId: string): Promise<string | null> {
  const row = await fetchRow(userId);
  if (!row?.kie_key_enc) return null;
  return decryptSecret(row.kie_key_enc);
}

export async function getKeyStatus(userId: string): Promise<{ anthropic: boolean; kie: boolean }> {
  const row = await fetchRow(userId);
  return { anthropic: !!row?.anthropic_key_enc, kie: !!row?.kie_key_enc };
}
```

- [ ] **Step 2: Verify build** (`npm run build` → SUCCESS).

- [ ] **Step 3: Commit**

```bash
git add lib/settings/user-secrets.ts
git commit -m "feat: per-user secret read helpers"
```

---

### Task 4: API keys config section + save action

**Files:**
- Modify: `app/(app)/config/page.tsx`
- Modify: `app/(app)/config/actions.ts`
- Create: `app/(app)/config/keys-section.tsx`

**Interfaces:**
- Consumes: `requireUser`, `getKeyStatus` (Task 3), `encryptSecret` (Task 1).
- Produces: server action `saveApiKeys(prev, formData)`; a Keys section on `/config` showing set/not-set status and inputs.

- [ ] **Step 1: Add `saveApiKeys` to `app/(app)/config/actions.ts`**

Add these imports at the top (keep existing ones):

```ts
import { requireUser } from "@/lib/auth/require-user";
import { encryptSecret } from "@/lib/crypto/secrets";
```

Append the action:

```ts
export async function saveApiKeys(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  const supabase = await createServerSupabase();
  const anthropic = String(formData.get("anthropic") ?? "").trim();
  const kie = String(formData.get("kie") ?? "").trim();

  // Only overwrite a key when a new value was typed (blank = leave unchanged).
  const patch: Record<string, string> = { user_id: user.id };
  if (anthropic) patch.anthropic_key_enc = encryptSecret(anthropic);
  if (kie) patch.kie_key_enc = encryptSecret(kie);

  const { error } = await supabase.from("user_settings").upsert(patch, { onConflict: "user_id" });
  if (error) return { error: error.message };
  revalidatePath("/config");
  return { ok: true };
}
```

- [ ] **Step 2: Implement `app/(app)/config/keys-section.tsx`**

```tsx
"use client";
import { useActionState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { saveApiKeys } from "./actions";

export function KeysSection({ status }: { status: { anthropic: boolean; kie: boolean } }) {
  const [state, action, pending] = useActionState(saveApiKeys, undefined);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">API Keys</CardTitle></CardHeader>
      <CardContent>
        <form action={action} className="space-y-3">
          <div>
            <Label className="flex items-center gap-2">
              Anthropic key
              <Badge variant={status.anthropic ? "success" : "outline"}>
                {status.anthropic ? "set" : "not set"}
              </Badge>
            </Label>
            <Input name="anthropic" type="password" placeholder="sk-ant-… (leave blank to keep)" />
          </div>
          <div>
            <Label className="flex items-center gap-2">
              Kie.ai key
              <Badge variant={status.kie ? "success" : "outline"}>
                {status.kie ? "set" : "not set"}
              </Badge>
            </Label>
            <Input name="kie" type="password" placeholder="Kie API key (leave blank to keep)" />
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save keys"}</Button>
            {state?.ok && <span className="text-sm text-status-success">Saved.</span>}
            {state?.error && <span className="text-sm text-destructive">{state.error}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Wire the Keys section into `app/(app)/config/page.tsx`**

Rewrite the page to fetch key status server-side and render the section above the category list:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getKeyStatus } from "@/lib/settings/user-secrets";
import { ConfigForm } from "./config-form";
import { KeysSection } from "./keys-section";
import type { Category } from "@/lib/types";

export default async function ConfigPage() {
  const user = await requireUser();
  const status = await getKeyStatus(user.id);
  const supabase = await createServerSupabase();
  const { data } = await supabase.from("categories").select("*").order("key");
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Config</h1>
      <KeysSection status={status} />
      {((data ?? []) as Category[]).map((c) => <ConfigForm key={c.key} category={c} />)}
    </div>
  );
}
```

- [ ] **Step 4: Verify build + manual check**

Run: `npm run build && npm test` → build succeeds, suite green.
Manual (with migration 0006 + `SECRETS_ENC_KEY` applied): on `/config`, save an Anthropic key, confirm the badge flips to "set" after save, and confirm re-saving with a blank field keeps it set.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config/actions.ts" "app/(app)/config/keys-section.tsx" "app/(app)/config/page.tsx"
git commit -m "feat: API keys config section with encrypted save"
```

---

### Task 5: Generic prompts + idea-generation refactor (TDD)

**Files:**
- Modify: `lib/athena/prompts.ts`
- Rewrite: `tests/prompts.test.ts`
- Modify: `lib/athena/generate-ideas.ts`

**Interfaces:**
- Consumes: `requireAnthropicKey` (Task 3); `BrandProfile` type (Task 2).
- Produces:
  - `interface BrandContext { business_name: string; business_description: string; audience: string; voice: string; avoid: string; }`
  - `buildIdeaSystemPrompt(brand: BrandContext, categories: { key: string; style_guide: string; output_format: string }[]): string`
  - `buildFilterSystemPrompt(brand: BrandContext): string`
  - `buildIdeaUserPrompt(count: number, activeKeys: string[]): string` (unchanged signature)
  - Existing `IdeasOutput`, `FilterOutput`, `IdeasOutputT`, `FilterOutputT` exports stay.
  - `generateIdeas(userId, categoryKey, count)` unchanged signature; internally fetches the user's brand + Anthropic key.

**Why combined:** `generate-ideas.ts` is the only consumer of these prompt functions, and the prompt signature change (`FILTER_SYSTEM_PROMPT` const → `buildFilterSystemPrompt(brand)` function; `buildIdeaSystemPrompt` gains a `brand` param) breaks `generate-ideas.ts` the moment `prompts.ts` changes. Doing both in one task keeps every commit's build green.

- [ ] **Step 1: Rewrite `tests/prompts.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  buildIdeaSystemPrompt, buildFilterSystemPrompt, buildIdeaUserPrompt,
  type BrandContext,
} from "@/lib/athena/prompts";

const brand: BrandContext = {
  business_name: "Athena",
  business_description: "An SAT prep platform that teaches like a personal tutor.",
  audience: "Parents of high-schoolers",
  voice: "Warm, encouraging, plain-spoken",
  avoid: "AI-powered, dashboards, analytics",
};

const cats = [
  { key: "MYTH", style_guide: "Bold headline over a flat illustration.", output_format: "myth, scene, insight line" },
];

describe("buildIdeaSystemPrompt", () => {
  it("injects the brand context fields", () => {
    const p = buildIdeaSystemPrompt(brand, cats);
    expect(p).toContain("Athena");
    expect(p).toContain("Parents of high-schoolers");
    expect(p).toContain("Warm, encouraging, plain-spoken");
    expect(p).toContain("AI-powered, dashboards, analytics");
  });
  it("injects each category's style guide and output format", () => {
    const p = buildIdeaSystemPrompt(brand, cats);
    expect(p).toContain("MYTH");
    expect(p).toContain("Bold headline over a flat illustration.");
    expect(p).toContain("myth, scene, insight line");
  });
  it("degrades gracefully on empty brand and empty category fields", () => {
    const empty: BrandContext = { business_name: "", business_description: "", audience: "", voice: "", avoid: "" };
    const p = buildIdeaSystemPrompt(empty, [{ key: "X", style_guide: "", output_format: "" }]);
    expect(typeof p).toBe("string");
    expect(p).toContain("X");
    expect(p).not.toContain("undefined");
  });
});

describe("buildFilterSystemPrompt", () => {
  it("frames the quality check around the brand", () => {
    const p = buildFilterSystemPrompt(brand);
    expect(p).toContain("Athena");
    expect(p).toContain("Parents of high-schoolers");
  });
});

describe("buildIdeaUserPrompt", () => {
  it("handles a single category", () => {
    expect(buildIdeaUserPrompt(3, ["MYTH"])).toContain("MYTH");
  });
  it("handles multiple categories", () => {
    expect(buildIdeaUserPrompt(6, ["A", "B"])).toContain("A, B");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL — `buildFilterSystemPrompt`/`BrandContext` not exported; signature mismatch.

- [ ] **Step 3: Rewrite `lib/athena/prompts.ts`**

```ts
import { z } from "zod";

export interface BrandContext {
  business_name: string;
  business_description: string;
  audience: string;
  voice: string;
  avoid: string;
}

function brandBlock(brand: BrandContext): string {
  const lines: string[] = [];
  if (brand.business_name) lines.push(`Business: ${brand.business_name}`);
  if (brand.business_description) lines.push(`What it is: ${brand.business_description}`);
  if (brand.audience) lines.push(`Primary audience: ${brand.audience}`);
  if (brand.voice) lines.push(`Voice / tone: ${brand.voice}`);
  if (brand.avoid) lines.push(`Never lead with / avoid: ${brand.avoid}`);
  return lines.length ? lines.join("\n") : "(No brand profile set yet — keep it generic and on-topic.)";
}

export function buildIdeaSystemPrompt(
  brand: BrandContext,
  categories: { key: string; style_guide: string; output_format: string }[],
): string {
  const guides = categories
    .map((c) => {
      const parts = [`=== ${c.key} ===`];
      parts.push(c.style_guide || "[No style guide — fill in Config]");
      if (c.output_format) parts.push(`OUTPUT FORMAT: ${c.output_format}`);
      return parts.join("\n");
    })
    .join("\n\n");

  return [
    "You are the creative content strategist for this business.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    "CATEGORY STYLE GUIDES (for context only — do NOT repeat these back in your output, they are stored separately):",
    guides,
    "",
    "CRITICAL INSTRUCTION FOR concept:",
    "Do NOT write a full image-generation prompt. Do NOT restate or summarize the style guide.",
    "Write only the specific creative content for this one idea — detailed enough that someone could generate the image from it later, but nothing about general style, palette, or layout (that already lives in the style guide).",
    "When a category specifies an OUTPUT FORMAT, follow it exactly for that category's ideas.",
  ].join("\n");
}

export function buildIdeaUserPrompt(count: number, activeKeys: string[]): string {
  return activeKeys.length === 1
    ? `Generate exactly ${count} content ideas for the ${activeKeys[0]} category.`
    : `Generate exactly ${count} content ideas distributed roughly evenly across: ${activeKeys.join(", ")}.`;
}

export function buildFilterSystemPrompt(brand: BrandContext): string {
  return [
    "You are a strict content quality reviewer for this business's social content. For each idea evaluate:",
    `1. Does it align with the brand? ${brandBlock(brand)}`,
    "2. Would it genuinely resonate with the target audience?",
    "3. Is it fresh and not a tired cliché?",
    "",
    "Return a decision for every idea, same idea_id values as the input.",
  ].join("\n");
}

export const IdeasOutput = z.object({
  ideas: z.array(z.object({ category: z.string(), concept: z.string() })),
});
export type IdeasOutputT = z.infer<typeof IdeasOutput>;

export const FilterOutput = z.object({
  decisions: z.array(
    z.object({ idea_id: z.string(), keep: z.boolean(), reason: z.string() }),
  ),
});
export type FilterOutputT = z.infer<typeof FilterOutput>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/prompts.test.ts` → all PASS. (The build is still red at this point — `generate-ideas.ts` hasn't been updated yet; fixed in Step 5 before any commit.)

- [ ] **Step 5: Update `lib/athena/generate-ideas.ts` to the new prompts + per-user key**

Update imports:

```ts
import {
  buildIdeaSystemPrompt, buildIdeaUserPrompt,
  buildFilterSystemPrompt, IdeasOutput, FilterOutput,
  type BrandContext,
} from "@/lib/athena/prompts";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
```

At the top of `generateIdeas`, build the Anthropic client with the user's key, and after resolving categories fetch the user's brand:

```ts
export async function generateIdeas(userId: string, categoryKey: string, count: number) {
  const supabase = createAdminSupabase();
  const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(userId) });

  let query = supabase.from("categories").select("*").eq("user_id", userId).eq("active", true);
  if (categoryKey !== "ALL") query = query.eq("key", categoryKey);
  const { data: categories, error: catErr } = await query;
  if (catErr) throw new Error(`categories query failed: ${catErr.message}`);
  if (!categories?.length) throw new Error(`no active categories for "${categoryKey}"`);
  const cats = categories as Category[];
  const activeKeys = cats.map((c) => c.key);

  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").eq("user_id", userId).maybeSingle();
  const brand: BrandContext = {
    business_name: brandRow?.business_name ?? "",
    business_description: brandRow?.business_description ?? "",
    audience: brandRow?.audience ?? "",
    voice: brandRow?.voice ?? "",
    avoid: brandRow?.avoid ?? "",
  };
```

Then use the brand + generic builders in the two Anthropic calls — the idea call:

```ts
    system: buildIdeaSystemPrompt(brand, cats),
```

and the filter call (replacing the old `FILTER_SYSTEM_PROMPT` const reference):

```ts
    system: buildFilterSystemPrompt(brand),
```

(`cats` are `Category` rows which structurally supply `key`/`style_guide`/`output_format`. `MODEL` stays read from `process.env.CLAUDE_MODEL` — the app-level default is unchanged. The rest of the function — the `user_id`-stamped insert, the filter merge — is unchanged.)

- [ ] **Step 6: Verify build + full suite green**

Run: `npm run build && npm test`
Expected: build succeeds (prompts + generate-ideas now consistent), all tests pass (prompts suite rewritten, others unchanged).

- [ ] **Step 7: Commit**

```bash
git add lib/athena/prompts.ts tests/prompts.test.ts lib/athena/generate-ideas.ts
git commit -m "feat: genericize prompts around brand context; idea generation uses the user's key + brand"
```

---

### Task 6: Brand profile editor

**Files:**
- Modify: `app/(app)/config/actions.ts`
- Create: `app/(app)/config/brand-section.tsx`
- Modify: `app/(app)/config/page.tsx`

**Interfaces:**
- Consumes: `requireUser`, `BrandProfile` type.
- Produces: server action `saveBrandProfile(prev, formData)`; a Brand section on `/config`.

- [ ] **Step 1: Add `saveBrandProfile` to `app/(app)/config/actions.ts`**

```ts
export async function saveBrandProfile(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("brand_profiles").upsert(
    {
      user_id: user.id,
      business_name: String(formData.get("business_name") ?? "").trim(),
      business_description: String(formData.get("business_description") ?? "").trim(),
      audience: String(formData.get("audience") ?? "").trim(),
      voice: String(formData.get("voice") ?? "").trim(),
      avoid: String(formData.get("avoid") ?? "").trim(),
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };
  revalidatePath("/config");
  return { ok: true };
}
```

- [ ] **Step 2: Implement `app/(app)/config/brand-section.tsx`**

```tsx
"use client";
import { useActionState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { saveBrandProfile } from "./actions";
import type { BrandProfile } from "@/lib/types";

export function BrandSection({ brand }: { brand: BrandProfile | null }) {
  const [state, action, pending] = useActionState(saveBrandProfile, undefined);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Brand</CardTitle></CardHeader>
      <CardContent>
        <form action={action} className="space-y-3">
          <div><Label>Business name</Label>
            <Input name="business_name" defaultValue={brand?.business_name ?? ""} /></div>
          <div><Label>What the business is</Label>
            <Textarea name="business_description" rows={3} defaultValue={brand?.business_description ?? ""} /></div>
          <div><Label>Target audience</Label>
            <Input name="audience" defaultValue={brand?.audience ?? ""} /></div>
          <div><Label>Voice / tone</Label>
            <Input name="voice" defaultValue={brand?.voice ?? ""} /></div>
          <div><Label>Never lead with / avoid</Label>
            <Textarea name="avoid" rows={2} defaultValue={brand?.avoid ?? ""} /></div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save brand"}</Button>
            {state?.ok && <span className="text-sm text-status-success">Saved.</span>}
            {state?.error && <span className="text-sm text-destructive">{state.error}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Wire into `app/(app)/config/page.tsx`**

Add the brand fetch and render the section between Keys and categories:

```tsx
import { BrandSection } from "./brand-section";
import type { BrandProfile, Category } from "@/lib/types";
// ...inside the component, after fetching status:
  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").maybeSingle();
// ...in JSX, after <KeysSection/>:
      <BrandSection brand={(brandRow as BrandProfile) ?? null} />
```

(The `brand_profiles` fetch uses the RLS-enforced `createServerSupabase` client, so `.maybeSingle()` returns only the caller's own row.)

- [ ] **Step 4: Verify build + suite** (`npm run build && npm test` → green). Manual: save a brand profile, reload `/config`, confirm fields persist.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config/actions.ts" "app/(app)/config/brand-section.tsx" "app/(app)/config/page.tsx"
git commit -m "feat: per-user brand profile editor"
```

---

### Task 7: Per-user Kie key through submission + poll

**Files:**
- Modify: `lib/athena/kie.ts`
- Modify: `lib/athena/submit-generations.ts`
- Modify: `app/api/jobs/poll/route.ts`

**Interfaces:**
- Consumes: `requireKieKey`, `getKieKeyOrNull` (Task 3).
- Produces: `uploadStyleRef(apiKey, styleRefUrl)`, `createKieTask(apiKey, prompt, styleUrl, aspectRatio)`, `getKieRecord(apiKey, taskId)` — each takes the key as its first arg.

- [ ] **Step 1: Update `lib/athena/kie.ts` to take an `apiKey` param**

Replace `kieHeaders()` and thread `apiKey`:

```ts
function kieHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

export async function uploadStyleRef(apiKey: string, styleRefUrl: string): Promise<string> {
  const res = await fetch("https://kieai.redpandaai.co/api/file-url-upload", {
    method: "POST",
    headers: kieHeaders(apiKey),
    body: JSON.stringify({ fileUrl: styleRefUrl, uploadPath: "athena-refs", fileName: "style_ref.jpg" }),
  });
  // ...rest unchanged...
}

export async function createKieTask(
  apiKey: string, prompt: string, styleUrl: string, aspectRatio: string,
): Promise<string> {
  const res = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST",
    headers: kieHeaders(apiKey),
    // ...body unchanged...
  });
  // ...rest unchanged...
}

export async function getKieRecord(apiKey: string, taskId: string): Promise<KieRecord> {
  const res = await fetch(
    `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { headers: kieHeaders(apiKey) },
  );
  // ...rest unchanged...
}
```

- [ ] **Step 2: Update `lib/athena/submit-generations.ts`**

Import and resolve the key once, pass to the Kie calls:

```ts
import { requireKieKey } from "@/lib/settings/user-secrets";
// ...inside submitGenerations, after `const supabase = createAdminSupabase();`:
  const kieKey = await requireKieKey(userId);
// ...in the loop:
      styleUrl = await uploadStyleRef(kieKey, category.style_ref_url);
// ...
      const taskId = await createKieTask(kieKey, fullPrompt, styleUrl, category.aspect_ratio);
```

- [ ] **Step 3: Update `app/api/jobs/poll/route.ts` for per-generation keys**

The cron spans all users. Resolve each generation's owner key, caching per user within the tick; skip (leave for next tick) a generation whose owner has no key:

```ts
import { getKieKeyOrNull } from "@/lib/settings/user-secrets";
// ...inside GET, before the loop:
  const keyCache = new Map<string, string | null>();
  async function kieKeyFor(uid: string): Promise<string | null> {
    if (!keyCache.has(uid)) keyCache.set(uid, await getKieKeyOrNull(uid));
    return keyCache.get(uid) ?? null;
  }
// ...at the top of the try block for each gen:
      const apiKey = await kieKeyFor(gen.user_id);
      if (!apiKey) continue; // owner removed their key; leave the row for a later tick
      const record = await getKieRecord(apiKey, gen.kie_task_id);
```

(`ingestImage` still uploads to the shared Cloudinary — no per-user key there. Task 8 extracts that upload to a shared module; this task leaves `ingestImage` as-is.)

- [ ] **Step 4: Verify build + suite**

Run: `npm run build && npm test`
Expected: build succeeds (all three files consistent), suite green (note: `tests/poll-logic.test.ts` tests the pure `decidePoll`, whose signature is unchanged, so it stays green).

- [ ] **Step 5: Commit**

```bash
git add lib/athena/kie.ts lib/athena/submit-generations.ts app/api/jobs/poll/route.ts
git commit -m "feat: image submission and poll cron use each user's Kie key"
```

---

### Task 8: Shared Cloudinary upload + style-ref image upload

**Files:**
- Create: `lib/cloudinary.ts`
- Modify: `app/api/jobs/poll/route.ts` (use the shared helper)
- Modify: `app/(app)/config/actions.ts` (add `uploadStyleRefImage`)

**Interfaces:**
- Produces:
  - `uploadImageToCloudinary(buffer: Buffer, mime: string): Promise<{ publicId: string; url: string }>` in `lib/cloudinary.ts`.
  - server action `uploadStyleRefImage(formData: FormData): Promise<{ url?: string; error?: string }>` — used by the category manager (Task 9).

- [ ] **Step 1: Create `lib/cloudinary.ts` (extracted from the poll route)**

```ts
import "server-only";

export async function uploadImageToCloudinary(
  buffer: Buffer,
  mime: string,
): Promise<{ publicId: string; url: string }> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloudName || !preset) throw new Error("Cloudinary env vars not configured");

  // Base64 data URI in a URL-encoded body (pure ASCII) — Vercel's runtime
  // corrupts raw binary request bodies (see Phase 2 fix).
  const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;
  const body = new URLSearchParams({ file: dataUri, upload_preset: preset });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`cloudinary upload failed: HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { public_id: string; secure_url: string };
  return { publicId: json.public_id, url: json.secure_url };
}
```

- [ ] **Step 2: Replace the poll route's inline `uploadToCloudinary`**

In `app/api/jobs/poll/route.ts`, delete the local `uploadToCloudinary` function and import the shared one; in `ingestImage`, call it with the jpeg buffer:

```ts
import { uploadImageToCloudinary } from "@/lib/cloudinary";
// ...in ingestImage, replace the uploadToCloudinary(jpeg) call:
  const { publicId, url } = await uploadImageToCloudinary(jpeg, "image/jpeg");
```

- [ ] **Step 3: Add `uploadStyleRefImage` to `app/(app)/config/actions.ts`**

```ts
import { uploadImageToCloudinary } from "@/lib/cloudinary";
// ...
export async function uploadStyleRefImage(
  formData: FormData,
): Promise<{ url?: string; error?: string }> {
  await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "No file provided" };
  if (file.size > 10 * 1024 * 1024) return { error: "Image must be under 10MB" };
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const { url } = await uploadImageToCloudinary(buffer, file.type || "image/jpeg");
    return { url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Verify build + suite** (`npm run build && npm test` → green).

- [ ] **Step 5: Commit**

```bash
git add lib/cloudinary.ts app/api/jobs/poll/route.ts "app/(app)/config/actions.ts"
git commit -m "feat: shared Cloudinary upload + style-ref image upload action"
```

---

### Task 9: Category CRUD (config manager rework)

**Files:**
- Modify: `app/(app)/config/actions.ts` (add create/delete; extend update with output_format; drop the `buffer_account` 1|2 validation)
- Create: `app/(app)/config/category-manager.tsx`
- Modify: `app/(app)/config/page.tsx` (render the manager)
- Delete: `app/(app)/config/config-form.tsx` (replaced by the manager)

**Interfaces:**
- Consumes: `requireUser`, `uploadStyleRefImage` (Task 8), `Category` type (with `output_format`).
- Produces: `createCategory(fields)`, `updateCategory(id, fields)`, `deleteCategory(id)` server actions; a category manager UI supporting add/edit/delete and style-ref upload.

- [ ] **Step 1: Rework the category actions in `app/(app)/config/actions.ts`**

Replace the existing `CategoryUpdate` interface and `updateCategory` with id-keyed CRUD that includes `output_format` and drops the Buffer-1|2 validation (Buffer config is Phase C; new categories take the schema defaults for `buffer_account`/`buffer_channel_id`/`post_caption`):

```ts
export interface CategoryFields {
  name: string;
  style_guide: string;
  output_format: string;
  style_ref_url: string;
  images_per_carousel: number;
  aspect_ratio: string;
  active: boolean;
}

function validateFields(f: CategoryFields) {
  if (!f.name.trim()) throw new Error("Name is required");
  if (!Number.isInteger(f.images_per_carousel) || f.images_per_carousel < 1 || f.images_per_carousel > 10) {
    throw new Error("images_per_carousel must be 1-10");
  }
}

function slugify(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "CATEGORY";
}

export async function createCategory(fields: CategoryFields) {
  const user = await requireUser();
  validateFields(fields);
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("categories").insert({
    user_id: user.id,
    key: slugify(fields.name),
    name: fields.name,
    style_guide: fields.style_guide,
    output_format: fields.output_format,
    style_ref_url: fields.style_ref_url,
    images_per_carousel: fields.images_per_carousel,
    aspect_ratio: fields.aspect_ratio || "4:5",
    active: fields.active,
  });
  if (error) {
    if (error.code === "23505") throw new Error("You already have a category with a similar name");
    throw new Error(error.message);
  }
  revalidatePath("/config");
}

export async function updateCategory(id: string, fields: CategoryFields) {
  await requireUser();
  validateFields(fields);
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("categories").update({
    name: fields.name,
    style_guide: fields.style_guide,
    output_format: fields.output_format,
    style_ref_url: fields.style_ref_url,
    images_per_carousel: fields.images_per_carousel,
    aspect_ratio: fields.aspect_ratio || "4:5",
    active: fields.active,
  }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/config");
}

export async function deleteCategory(id: string) {
  await requireUser();
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/config");
}
```

(These use the RLS-enforced `createServerSupabase`, so `.eq("id", id)`/`.delete()` only affect the caller's own rows. `key` uniqueness is per-user via the Phase A composite constraint. Note: `deleteCategory` will fail with a FK error if the category still has ideas/posts — that's acceptable for the beta; the error surfaces to the user. A cascade is out of scope.)

- [ ] **Step 2: Implement `app/(app)/config/category-manager.tsx`**

```tsx
"use client";
import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  createCategory, updateCategory, deleteCategory, uploadStyleRefImage,
  type CategoryFields,
} from "./actions";
import type { Category } from "@/lib/types";

const EMPTY: CategoryFields = {
  name: "", style_guide: "", output_format: "", style_ref_url: "",
  images_per_carousel: 5, aspect_ratio: "4:5", active: true,
};

function CategoryEditor({ category }: { category?: Category }) {
  const router = useRouter();
  const [form, setForm] = useState<CategoryFields>(
    category
      ? {
          name: category.name, style_guide: category.style_guide,
          output_format: category.output_format, style_ref_url: category.style_ref_url,
          images_per_carousel: category.images_per_carousel,
          aspect_ratio: category.aspect_ratio, active: category.active,
        }
      : EMPTY,
  );
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function set<K extends keyof CategoryFields>(k: K, v: CategoryFields[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setMsg("");
    const fd = new FormData();
    fd.append("file", file);
    const res = await uploadStyleRefImage(fd);
    setUploading(false);
    if (res.error) { setMsg(`Upload failed: ${res.error}`); return; }
    if (res.url) set("style_ref_url", res.url);
  }

  function save() {
    startTransition(async () => {
      try {
        if (category) await updateCategory(category.id, form);
        else { await createCategory(form); setForm(EMPTY); }
        setMsg("Saved.");
        router.refresh();
      } catch (e) {
        setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  function remove() {
    if (!category) return;
    startTransition(async () => {
      try { await deleteCategory(category.id); router.refresh(); }
      catch (e) { setMsg(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
    });
  }

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <Input className="max-w-xs" placeholder="Category name" value={form.name}
          onChange={(e) => set("name", e.target.value)} />
        <div className="flex items-center gap-3">
          <Switch checked={form.active} onCheckedChange={(v) => set("active", v)} />
          {category && (
            <Button variant="destructive" size="sm" disabled={pending} onClick={remove}>Delete</Button>
          )}
        </div>
      </div>
      <div><Label>Style guide</Label>
        <Textarea rows={8} value={form.style_guide} onChange={(e) => set("style_guide", e.target.value)} /></div>
      <div><Label>Output format (how ideas in this category are structured)</Label>
        <Textarea rows={3} value={form.output_format} onChange={(e) => set("output_format", e.target.value)} /></div>
      <div><Label>Style reference image</Label>
        <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="block text-sm" />
        {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
        {form.style_ref_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={form.style_ref_url} alt="style ref" className="mt-2 h-40 rounded border object-cover" />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label>Images per carousel</Label>
          <Input type="number" min={1} max={10} value={form.images_per_carousel}
            onChange={(e) => set("images_per_carousel", Number(e.target.value))} /></div>
        <div><Label>Aspect ratio</Label>
          <Input value={form.aspect_ratio} onChange={(e) => set("aspect_ratio", e.target.value)} /></div>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending || uploading}>
          {pending ? "Saving…" : category ? "Save" : "Add category"}
        </Button>
        <span className="text-sm text-muted-foreground">{msg}</span>
      </div>
    </div>
  );
}

export function CategoryManager({ categories }: { categories: Category[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Categories</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {categories.map((c) => <CategoryEditor key={c.id} category={c} />)}
        <div>
          <p className="mb-2 text-sm font-medium">Add a new category</p>
          <CategoryEditor />
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Render the manager in `app/(app)/config/page.tsx` and delete `config-form.tsx`**

Replace the category `.map(ConfigForm)` with the manager:

```tsx
import { CategoryManager } from "./category-manager";
// ...in JSX, replace the ConfigForm map with:
      <CategoryManager categories={(data ?? []) as Category[]} />
```

Remove the `ConfigForm` import, then delete the file:

```bash
git rm "app/(app)/config/config-form.tsx"
```

- [ ] **Step 4: Verify build + suite + manual**

Run: `npm run build && npm test`
Expected: build succeeds (no dangling `ConfigForm`/`CategoryUpdate` references), suite green.
Manual: add a category with a name, style guide, output format, and an uploaded style-ref image; confirm it persists and appears; edit it; delete an empty one.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/config"
git commit -m "feat: full category CRUD with output format and style-ref upload"
```

---

## Phase B completion

After Task 9 is green: a signed-up user can enter their own Anthropic + Kie keys (encrypted at rest), define their brand profile and any number of categories with uploaded style references, and generate on-brand ideas + images entirely on their own keys and content — isolated from every other user. Posting is still Phase C (Buffer OAuth). The manual end-to-end check for the phase: as a fresh test user, add keys + brand + one category with a style ref, generate ideas, approve one, generate an image, and confirm it appears in the gallery — all without any Athena/hardcoded data. Then write the Phase C plan.
