# Athena Content App — Phase 0+1 Implementation Plan (Foundation + Ideas)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deployed Next.js + Supabase app where the user can edit category config, generate content ideas with Claude (with AI self-filtering), and review/approve them on an ideas board.

**Architecture:** Next.js App Router app on Vercel; all secrets live in server-only API routes and server actions. Supabase Postgres is the source of truth (replacing Google Sheets); Supabase Auth (magic link, single allowlisted email) gates every page. Idea generation ports the n8n Workflow A logic: one Claude call to generate ideas, a second to self-filter, using structured outputs instead of the old JSON-repair parsing.

**Tech Stack:** Next.js (latest, App Router, TypeScript), Tailwind + shadcn/ui, `@supabase/supabase-js` + `@supabase/ssr`, `@anthropic-ai/sdk` (+ zod structured outputs helper), vitest, `xlsx` (seed script only), `tsx` (script runner).

**Spec:** `docs/superpowers/specs/2026-07-20-athena-content-app-design.md`

## Global Constraints

- TypeScript strict mode; no `any` unless unavoidable.
- Secrets (`ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, Buffer/Kie keys later) are **never** imported into client components. Only `NEXT_PUBLIC_*` vars reach the browser.
- Claude model comes from env `CLAUDE_MODEL`, default **`claude-sonnet-5`**. Never pass `temperature`/`top_p`/`budget_tokens` (400s on this model). Omit `thinking` (adaptive is the default on Sonnet 5).
- Category keys are exactly: `SAT_MYTH`, `BRAIN_TEASER`, `NOTES_APP`, `COMIC`, `BEAGLE_EXPLAINS`.
- Idea status values are exactly: `pending_review`, `approved`, `rejected`, `generating`, `generated`, `posted`, `failed`.
- Allowed login email comes from env `ALLOWED_EMAIL` (value: `rdarugar@usc.edu`).
- Use the SDK's own types (`Anthropic.*`, supabase generated-ish local types in `lib/types.ts`) — don't redefine SDK shapes.
- Commit after every task (steps include the commands).
- The n8n reference files in `n8n-files/` are read-only inputs; never modify them.

---

### Task 1: Scaffold the Next.js project

**Files:**
- Create: entire Next.js scaffold at repo root (`package.json`, `app/`, `next.config.ts`, …)
- Create: `.env.example`
- Modify: `.gitignore` (verify `.env*` ignored)

**Interfaces:**
- Consumes: nothing.
- Produces: a running Next.js app; npm scripts `dev`, `build`, `test`; import alias `@/*`; shadcn/ui installed with components `button card input textarea switch badge table select dialog sonner label`.

- [ ] **Step 1: Scaffold into repo root (temp-move trick — create-next-app refuses non-empty dirs)**

```bash
cd "/Users/rayyandarugar/Coding Projects/content-gen-app"
mkdir -p /tmp/athena-hold
mv docs n8n-files /tmp/athena-hold/
npx create-next-app@latest . --typescript --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-npm --no-turbopack
mv /tmp/athena-hold/docs /tmp/athena-hold/n8n-files .
rmdir /tmp/athena-hold
```

Expected: scaffold succeeds; `docs/` and `n8n-files/` restored. (If create-next-app's prompts differ from these flags, accept App Router + TS + Tailwind + ESLint + alias `@/*`.)

- [ ] **Step 2: Install dependencies**

```bash
npm install @supabase/supabase-js @supabase/ssr @anthropic-ai/sdk zod
npm install -D vitest tsx xlsx dotenv
```

- [ ] **Step 3: Init shadcn/ui and add components**

```bash
npx shadcn@latest init -d
npx shadcn@latest add button card input textarea switch badge table select dialog sonner label
```

- [ ] **Step 4: Add vitest config and test script**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
```

In `package.json` scripts add: `"test": "vitest run"` and `"seed": "tsx scripts/seed-categories.ts"`.

- [ ] **Step 5: Create `.env.example` and verify gitignore**

`.env.example`:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-5
ALLOWED_EMAIL=rdarugar@usc.edu
# Phase 2+
KIE_API_KEY=
CRON_SECRET=
# Phase 3
BUFFER_TOKEN_1=
BUFFER_TOKEN_2=
```

Verify `.gitignore` contains `.env*` (create-next-app default does). Run `npm run build` — expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: scaffold Next.js app with shadcn, supabase, anthropic deps"
```

---

### Task 2: Supabase project + schema migration

**Files:**
- Create: `supabase/migrations/0001_init.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `categories`, `ideas`, `generations`, `posts`, `post_images` with the exact columns below; later tasks rely on these names verbatim.

**⚠️ USER CHECKPOINT:** This task needs the user to create a Supabase project (supabase.com → New project) and paste the SQL into the dashboard SQL Editor, then provide `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` into `.env.local`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0001_init.sql`:

```sql
create extension if not exists "pgcrypto";

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table categories (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  style_guide text not null default '',
  style_ref_url text not null default '',
  post_caption text not null default '',
  buffer_channel_id text not null default '',
  buffer_account int not null default 1 check (buffer_account in (1, 2)),
  images_per_carousel int not null default 5,
  aspect_ratio text not null default '4:5',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger categories_updated_at before update on categories
  for each row execute function set_updated_at();

create table ideas (
  id uuid primary key default gen_random_uuid(),
  category_key text not null references categories(key),
  concept text not null,
  resolved_prompt text not null,
  ai_filter_reason text not null default '',
  approved boolean not null default false,
  status text not null default 'pending_review' check (status in
    ('pending_review','approved','rejected','generating','generated','posted','failed')),
  batch_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ideas_status_idx on ideas(status);
create index ideas_category_idx on ideas(category_key);
create trigger ideas_updated_at before update on ideas
  for each row execute function set_updated_at();

create table generations (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references ideas(id),
  kie_task_id text not null default '',
  status text not null default 'submitted' check (status in
    ('submitted','polling','succeeded','failed')),
  poll_count int not null default 0,
  kie_style_url text not null default '',
  full_prompt text not null default '',
  image_path text not null default '',
  public_url text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index generations_status_idx on generations(status);
create trigger generations_updated_at before update on generations
  for each row execute function set_updated_at();

create table posts (
  id uuid primary key default gen_random_uuid(),
  category_key text not null references categories(key),
  buffer_update_id text not null default '',
  caption text not null default '',
  status text not null default 'created' check (status in ('created','queued','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger posts_updated_at before update on posts
  for each row execute function set_updated_at();

create table post_images (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id),
  generation_id uuid not null references generations(id),
  sort_order int not null default 0
);

-- RLS: single-user app; authenticated users get full access, anon gets nothing.
alter table categories enable row level security;
alter table ideas enable row level security;
alter table generations enable row level security;
alter table posts enable row level security;
alter table post_images enable row level security;

create policy "auth full access" on categories for all to authenticated using (true) with check (true);
create policy "auth full access" on ideas for all to authenticated using (true) with check (true);
create policy "auth full access" on generations for all to authenticated using (true) with check (true);
create policy "auth full access" on posts for all to authenticated using (true) with check (true);
create policy "auth full access" on post_images for all to authenticated using (true) with check (true);
```

- [ ] **Step 2: USER — create Supabase project and apply**

Ask the user to: create the project, open SQL Editor, paste `0001_init.sql`, run it, then put the three Supabase values in `.env.local` (copy from `.env.example`). Also in Supabase dashboard → Authentication → Providers: leave Email enabled; under Auth settings set Site URL to `http://localhost:3000` for now.

- [ ] **Step 3: Verify tables exist**

In the Supabase SQL editor: `select table_name from information_schema.tables where table_schema='public';`
Expected: the five tables listed.

- [ ] **Step 4: Commit**

```bash
git add supabase/ && git commit -m "feat: initial Supabase schema (categories, ideas, generations, posts)"
```

---

### Task 3: Types and Supabase client helpers

**Files:**
- Create: `lib/types.ts`
- Create: `lib/supabase/server.ts`, `lib/supabase/browser.ts`, `lib/supabase/admin.ts`

**Interfaces:**
- Consumes: env vars from Task 2.
- Produces:
  - `Category`, `Idea`, `IdeaStatus`, `Generation` types (`lib/types.ts`)
  - `createServerSupabase(): Promise<SupabaseClient>` (cookie-bound, RLS, for server components/actions)
  - `createBrowserSupabase(): SupabaseClient` (client components)
  - `createAdminSupabase(): SupabaseClient` (service role — **server only**)

- [ ] **Step 1: Write `lib/types.ts`**

```ts
export type IdeaStatus =
  | "pending_review" | "approved" | "rejected"
  | "generating" | "generated" | "posted" | "failed";

export interface Category {
  id: string;
  key: string;
  name: string;
  style_guide: string;
  style_ref_url: string;
  post_caption: string;
  buffer_channel_id: string;
  buffer_account: 1 | 2;
  images_per_carousel: number;
  aspect_ratio: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Idea {
  id: string;
  category_key: string;
  concept: string;
  resolved_prompt: string;
  ai_filter_reason: string;
  approved: boolean;
  status: IdeaStatus;
  batch_id: string;
  created_at: string;
  updated_at: string;
}

export interface Generation {
  id: string;
  idea_id: string;
  kie_task_id: string;
  status: "submitted" | "polling" | "succeeded" | "failed";
  poll_count: number;
  kie_style_url: string;
  full_prompt: string;
  image_path: string;
  public_url: string;
  error: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Write the three clients**

`lib/supabase/server.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // called from a Server Component — middleware refreshes sessions
          }
        },
      },
    },
  );
}
```

`lib/supabase/browser.ts`:

```ts
import { createBrowserClient } from "@supabase/ssr";

export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

`lib/supabase/admin.ts`:

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

export function createAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
```

Also: `npm install server-only`.

- [ ] **Step 3: Build check + commit**

```bash
npm run build
git add lib/ package*.json && git commit -m "feat: supabase clients and domain types"
```

---

### Task 4: Auth — magic link login with email allowlist

**Files:**
- Create: `middleware.ts`, `app/login/page.tsx`, `app/auth/confirm/route.ts`, `app/auth/signout/route.ts`

**Interfaces:**
- Consumes: `createBrowserSupabase` (Task 3), env `ALLOWED_EMAIL`.
- Produces: every route except `/login` and `/auth/*` requires a session for `ALLOWED_EMAIL`; other emails are signed out and bounced to `/login?error=unauthorized`.

- [ ] **Step 1: Middleware**

`middleware.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;
  const isPublic = pathname.startsWith("/login") || pathname.startsWith("/auth");

  if (!user && !isPublic) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (user && user.email !== process.env.ALLOWED_EMAIL && !isPublic) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=unauthorized", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/jobs).*)"],
};
```

(`/api/jobs` is excluded now so the Phase 2 cron endpoint can use its own bearer auth.)

- [ ] **Step 2: Login page**

`app/login/page.tsx`:

```tsx
"use client";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const params = useSearchParams();

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
    });
    if (error) setErr(error.message);
    else setSent(true);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader><CardTitle>Athena Content</CardTitle></CardHeader>
      <CardContent>
        {sent ? (
          <p>Check your email for the sign-in link.</p>
        ) : (
          <form onSubmit={sendLink} className="space-y-3">
            <Input type="email" placeholder="you@example.com" value={email}
              onChange={(e) => setEmail(e.target.value)} required />
            <Button type="submit" className="w-full">Send magic link</Button>
            {params.get("error") === "unauthorized" && (
              <p className="text-sm text-red-500">That email is not allowed.</p>
            )}
            {err && <p className="text-sm text-red-500">{err}</p>}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
```

- [ ] **Step 3: Confirm + signout routes**

`app/auth/confirm/route.ts`:

```ts
import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (token_hash && type) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return NextResponse.redirect(new URL("/ideas", request.url));
  }
  return NextResponse.redirect(new URL("/login?error=invalid_link", request.url));
}
```

`app/auth/signout/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url));
}
```

- [ ] **Step 4: Manual verification**

Run `npm run dev`. Visit `http://localhost:3000` → expect redirect to `/login`. Send a magic link to `rdarugar@usc.edu` (user clicks it) → expect redirect to `/ideas` (404 for now — that's fine, the session cookie is what we're testing; verify no redirect back to /login when visiting `/`).

- [ ] **Step 5: Commit**

```bash
git add middleware.ts app/ && git commit -m "feat: magic-link auth with single-email allowlist"
```

---

### Task 5: Seed categories from the legacy config

**Files:**
- Create: `scripts/seed-categories.ts`

**Interfaces:**
- Consumes: `n8n-files/Athena Content Pipeline.xlsx` (Config sheet: columns `category`, `style_guide`, `beagle_ref_url`, `style_ref_url`, `post_caption`), admin client (Task 3).
- Produces: 5 rows in `categories` matching the legacy Config sheet + the routing maps from n8n Workflow C.

- [ ] **Step 1: Write the seed script**

`scripts/seed-categories.ts`:

```ts
import { config } from "dotenv";
config({ path: ".env.local" });
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

// Ported verbatim from n8n Workflow C "Select Posts" node.
const CHANNEL_MAP: Record<string, { channelId: string; account: 1 | 2; name: string }> = {
  SAT_MYTH:        { channelId: "6a5517eb80cc80cdcaac2ddf", account: 1, name: "athenalearns" },
  BRAIN_TEASER:    { channelId: "6a551bc880cc80cdcaac4e2d", account: 1, name: "athenastudy" },
  COMIC:           { channelId: "6a5518d580cc80cdcaac30f5", account: 1, name: "athenastudies_" },
  NOTES_APP:       { channelId: "6a552a2280cc80cdcaac9e06", account: 2, name: "athena.study" },
  BEAGLE_EXPLAINS: { channelId: "6a555a1e80cc80cdcaad980f", account: 2, name: "athena_study" },
};
const IMAGES_PER_CATEGORY: Record<string, number> = {
  SAT_MYTH: 5, BRAIN_TEASER: 5, COMIC: 5, NOTES_APP: 1, BEAGLE_EXPLAINS: 5,
};

async function main() {
  const wb = XLSX.readFile("n8n-files/Athena Content Pipeline.xlsx");
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets["Config"]);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  for (const row of rows) {
    const key = row.category?.trim();
    if (!key || !CHANNEL_MAP[key]) continue;
    const { error } = await supabase.from("categories").upsert(
      {
        key,
        name: key.replace(/_/g, " ").toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        style_guide: row.style_guide ?? "",
        style_ref_url: row.style_ref_url ?? "",
        post_caption: row.post_caption ?? "",
        buffer_channel_id: CHANNEL_MAP[key].channelId,
        buffer_account: CHANNEL_MAP[key].account,
        images_per_carousel: IMAGES_PER_CATEGORY[key] ?? 5,
        aspect_ratio: "4:5",
        active: true,
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(`${key}: ${error.message}`);
    console.log(`upserted ${key}`);
  }

  const { count } = await supabase
    .from("categories").select("*", { count: "exact", head: true });
  console.log(`done — ${count} categories in table`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run and verify**

```bash
npm run seed
```

Expected output: `upserted` × 5 lines, then `done — 5 categories in table`. Re-run to confirm idempotency (still 5).

- [ ] **Step 3: Commit**

```bash
git add scripts/ && git commit -m "feat: seed categories from legacy n8n config"
```

---

### Task 6: Prompt builder + filter merge logic (TDD)

**Files:**
- Create: `lib/athena/prompts.ts`, `lib/athena/filter.ts`
- Test: `tests/prompts.test.ts`, `tests/filter.test.ts`

**Interfaces:**
- Consumes: `Category` type (Task 3).
- Produces (used verbatim by Task 7):
  - `buildIdeaSystemPrompt(categories: Pick<Category,"key"|"style_guide">[]): string`
  - `buildIdeaUserPrompt(count: number, activeKeys: string[]): string`
  - `FILTER_SYSTEM_PROMPT: string`
  - `IdeasOutput` zod schema: `{ ideas: { category: string; concept: string }[] }`
  - `FilterOutput` zod schema: `{ decisions: { idea_id: string; keep: boolean; reason: string }[] }`
  - `applyFilterDecisions(ideas: {idea_id: string; category: string; concept: string}[], decisions: {idea_id: string; keep: boolean; reason: string}[]): {idea_id: string; category: string; concept: string; ai_keep: boolean; ai_filter_reason: string}[]`

- [ ] **Step 1: Write the failing tests**

`tests/prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildIdeaSystemPrompt, buildIdeaUserPrompt } from "@/lib/athena/prompts";

const cats = [
  { key: "SAT_MYTH", style_guide: "Myth style guide text" },
  { key: "COMIC", style_guide: "Comic style guide text" },
];

describe("buildIdeaSystemPrompt", () => {
  it("includes brand rules and each category guide with === headers", () => {
    const s = buildIdeaSystemPrompt(cats);
    expect(s).toContain("creative content strategist for Athena");
    expect(s).toContain("NON-NEGOTIABLE BRAND RULES");
    expect(s).toContain("=== SAT_MYTH ===\nMyth style guide text");
    expect(s).toContain("=== COMIC ===\nComic style guide text");
    expect(s).toContain("Do NOT write a full image-generation prompt");
  });
  it("falls back for a missing style guide", () => {
    const s = buildIdeaSystemPrompt([{ key: "X", style_guide: "" }]);
    expect(s).toContain("=== X ===\n[No style guide — fill in Config]");
  });
});

describe("buildIdeaUserPrompt", () => {
  it("single category", () => {
    expect(buildIdeaUserPrompt(5, ["COMIC"])).toBe(
      "Generate exactly 5 content ideas for the COMIC category.",
    );
  });
  it("multiple categories", () => {
    expect(buildIdeaUserPrompt(10, ["A", "B"])).toBe(
      "Generate exactly 10 content ideas distributed roughly evenly across: A, B.",
    );
  });
});
```

`tests/filter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyFilterDecisions } from "@/lib/athena/filter";

const ideas = [
  { idea_id: "a", category: "COMIC", concept: "one" },
  { idea_id: "b", category: "COMIC", concept: "two" },
];

describe("applyFilterDecisions", () => {
  it("applies keep/reject decisions by idea_id", () => {
    const out = applyFilterDecisions(ideas, [
      { idea_id: "a", keep: true, reason: "fresh" },
      { idea_id: "b", keep: false, reason: "cliche" },
    ]);
    expect(out[0]).toMatchObject({ idea_id: "a", ai_keep: true, ai_filter_reason: "fresh" });
    expect(out[1]).toMatchObject({ idea_id: "b", ai_keep: false, ai_filter_reason: "cliche" });
  });
  it("defaults to keep when a decision is missing", () => {
    const out = applyFilterDecisions(ideas, [{ idea_id: "a", keep: false, reason: "no" }]);
    expect(out[1]).toMatchObject({
      ai_keep: true,
      ai_filter_reason: "no decision returned — defaulting to keep",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/athena/prompts` / `filter`.

- [ ] **Step 3: Implement**

`lib/athena/prompts.ts` (system prompt ported verbatim from n8n "Build Claude Prompt Request", minus the JSON-format instructions — structured outputs handle that now):

```ts
import { z } from "zod";

export function buildIdeaSystemPrompt(
  categories: { key: string; style_guide: string }[],
): string {
  const guides = categories
    .map((c) => `=== ${c.key} ===\n${c.style_guide || "[No style guide — fill in Config]"}`)
    .join("\n\n");

  return [
    "You are the creative content strategist for Athena, an SAT prep platform.",
    "",
    "NON-NEGOTIABLE BRAND RULES:",
    "- Athena is a personalized TEACHER, never an AI product, dashboard, or analytics tool",
    "- Core outcome: Ohhhh... now I get it.",
    "- Mascot: A cute Beagle dog — curious, friendly, slightly goofy. The Beagle is the guide/student in content, never the product.",
    "- Primary audience: Parents aged 35-55 worried about SAT scores, college admissions, tutoring costs, their kid feeling stuck.",
    "- NEVER lead with: AI-powered, adaptive learning, algorithms, analytics, dashboards.",
    "",
    "CATEGORY STYLE GUIDES (for context only — do NOT repeat these back in your output, they are already stored separately):",
    guides,
    "",
    "CRITICAL INSTRUCTION FOR concept:",
    "Do NOT write a full image-generation prompt. Do NOT restate or summarize the style guide.",
    "Just write the specific creative content for this one idea — detailed enough that someone could generate the image from it later, but nothing about general style, palette, or layout (that already lives in the style guide).",
    "For multi-panel/carousel categories (COMIC, BEAGLE_EXPLAINS), write out each panel/beat in sequence, with the exact text/dialogue for each panel.",
    "For SAT_MYTH, include: the myth statement, the visual scene, and the insight line.",
    "For NOTES_APP, include the full note text verbatim.",
    "For BRAIN_TEASER, include the actual puzzle and its answer.",
  ].join("\n");
}

export function buildIdeaUserPrompt(count: number, activeKeys: string[]): string {
  return activeKeys.length === 1
    ? `Generate exactly ${count} content ideas for the ${activeKeys[0]} category.`
    : `Generate exactly ${count} content ideas distributed roughly evenly across: ${activeKeys.join(", ")}.`;
}

export const FILTER_SYSTEM_PROMPT = [
  "You are a strict content quality reviewer for Athena SAT prep content. For each idea evaluate:",
  "1. Does it align with the Athena brand — personalized teacher, not AI product?",
  "2. Would it genuinely resonate with parents of high-schoolers or students feeling stuck?",
  "3. Is it fresh and not a tired SAT prep cliche?",
  "",
  "Return a decision for every idea, same idea_id values as the input.",
].join("\n");

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

`lib/athena/filter.ts`:

```ts
interface RawIdea { idea_id: string; category: string; concept: string; }
interface Decision { idea_id: string; keep: boolean; reason: string; }

export function applyFilterDecisions(ideas: RawIdea[], decisions: Decision[]) {
  const map = new Map(decisions.map((d) => [d.idea_id, d]));
  return ideas.map((idea) => {
    const d = map.get(idea.idea_id);
    return {
      ...idea,
      ai_keep: d?.keep ?? true,
      ai_filter_reason: d?.reason ?? "no decision returned — defaulting to keep",
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/athena tests/ && git commit -m "feat: idea prompt builders and filter merge (ported from n8n workflow A)"
```

---

### Task 7: `/api/ideas/generate` route

**Files:**
- Create: `app/api/ideas/generate/route.ts`, `lib/athena/generate-ideas.ts`

**Interfaces:**
- Consumes: prompts/filter from Task 6, `createAdminSupabase` (Task 3), `createServerSupabase` for auth check.
- Produces: `POST /api/ideas/generate` body `{ categoryKey: string | "ALL", count: number }` → `202`-style JSON `{ inserted: number, filteredOut: number, batchId: string }`. Inserted `ideas` rows have `status='pending_review'`, `approved=false`, `resolved_prompt=concept`.

- [ ] **Step 1: Implement the core generator**

`lib/athena/generate-ideas.ts`:

```ts
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  buildIdeaSystemPrompt, buildIdeaUserPrompt,
  FILTER_SYSTEM_PROMPT, IdeasOutput, FilterOutput,
} from "@/lib/athena/prompts";
import { applyFilterDecisions } from "@/lib/athena/filter";
import type { Category } from "@/lib/types";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

export async function generateIdeas(categoryKey: string, count: number) {
  const supabase = createAdminSupabase();
  const anthropic = new Anthropic();

  let query = supabase.from("categories").select("*").eq("active", true);
  if (categoryKey !== "ALL") query = query.eq("key", categoryKey);
  const { data: categories, error: catErr } = await query;
  if (catErr) throw new Error(`categories query failed: ${catErr.message}`);
  if (!categories?.length) throw new Error(`no active categories for "${categoryKey}"`);
  const cats = categories as Category[];
  const activeKeys = cats.map((c) => c.key);

  // Call 1: generate ideas (structured output replaces the old JSON-repair parse)
  const genResponse = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: buildIdeaSystemPrompt(cats),
    messages: [{ role: "user", content: buildIdeaUserPrompt(count, activeKeys) }],
    output_format: zodOutputFormat(IdeasOutput),
  });
  const generated = genResponse.parsed_output;
  if (!generated) throw new Error(`idea generation returned no parseable output (stop_reason: ${genResponse.stop_reason})`);

  const raw = generated.ideas
    .filter((i) => activeKeys.includes(i.category))
    .map((i, idx) => ({ idea_id: `idea_${idx}`, category: i.category, concept: i.concept }));
  if (!raw.length) throw new Error("Claude returned zero usable ideas");

  // Call 2: self-filter
  const filterResponse = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system: FILTER_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: "Review and filter these ideas:\n" + JSON.stringify(raw, null, 2),
    }],
    output_format: zodOutputFormat(FilterOutput),
  });
  const decisions = filterResponse.parsed_output?.decisions ?? [];
  const merged = applyFilterDecisions(raw, decisions);

  const kept = merged.filter((i) => i.ai_keep);
  const batchId = randomUUID();
  if (kept.length) {
    const { error: insErr } = await supabase.from("ideas").insert(
      kept.map((i) => ({
        category_key: i.category,
        concept: i.concept,
        resolved_prompt: i.concept,
        ai_filter_reason: i.ai_filter_reason,
        approved: false,
        status: "pending_review",
        batch_id: batchId,
      })),
    );
    if (insErr) throw new Error(`insert failed: ${insErr.message}`);
  }
  return { inserted: kept.length, filteredOut: merged.length - kept.length, batchId };
}
```

- [ ] **Step 2: Implement the route (auth-gated)**

`app/api/ideas/generate/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { generateIdeas } from "@/lib/athena/generate-ideas";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== process.env.ALLOWED_EMAIL) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryKey = body?.categoryKey;
  const count = Number(body?.count);
  if (typeof categoryKey !== "string" || !Number.isInteger(count) || count < 1 || count > 20) {
    return NextResponse.json(
      { error: "expected { categoryKey: string, count: 1-20 }" }, { status: 400 });
  }

  try {
    const result = await generateIdeas(categoryKey, count);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("idea generation failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Live verification (needs ANTHROPIC_API_KEY in `.env.local` — ask user if missing)**

With `npm run dev` running and a logged-in browser session, run from the browser devtools console (so auth cookies are sent):

```js
await fetch("/api/ideas/generate", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ categoryKey: "SAT_MYTH", count: 2 }),
}).then(r => r.json());
```

Expected: `{ inserted: <1-2>, filteredOut: <0-1>, batchId: "..." }` and matching rows in Supabase `ideas` table.

- [ ] **Step 4: Commit**

```bash
git add app/api lib/athena && git commit -m "feat: idea generation API with Claude structured outputs and self-filter"
```

---

### Task 8: App shell + nav layout

**Files:**
- Create: `app/(app)/layout.tsx`
- Modify: `app/page.tsx` (redirect to `/ideas`)
- Delete: default create-next-app home content

**Interfaces:**
- Consumes: auth (Task 4).
- Produces: an `(app)` route group whose layout renders sidebar nav (Ideas · Generate · Gallery · Post · Config) + signout; Tasks 9–11 create pages inside `app/(app)/`.

- [ ] **Step 1: Root redirect**

`app/page.tsx`:

```tsx
import { redirect } from "next/navigation";
export default function Home() { redirect("/ideas"); }
```

- [ ] **Step 2: App-group layout**

`app/(app)/layout.tsx`:

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";

const nav = [
  { href: "/ideas", label: "Ideas" },
  { href: "/generate", label: "Generate" },
  { href: "/gallery", label: "Gallery" },
  { href: "/post", label: "Post" },
  { href: "/config", label: "Config" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-48 shrink-0 border-r p-4 flex flex-col gap-1">
        <div className="font-bold mb-4">Athena Content</div>
        {nav.map((n) => (
          <Link key={n.href} href={n.href}
            className="rounded px-3 py-2 text-sm hover:bg-accent">{n.label}</Link>
        ))}
        <form action="/auth/signout" method="post" className="mt-auto">
          <Button variant="ghost" size="sm" type="submit">Sign out</Button>
        </form>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
```

(Gallery and Post links will 404 until Phases 2–3 — acceptable; they're the roadmap.)

- [ ] **Step 3: Verify + commit**

`npm run dev` → `/` redirects to `/ideas` (404 body inside the shell is fine until Task 10).

```bash
git add app/ && git commit -m "feat: app shell with sidebar navigation"
```

---

### Task 9: /generate page

**Files:**
- Create: `app/(app)/generate/page.tsx`, `app/(app)/generate/generate-form.tsx`

**Interfaces:**
- Consumes: `GET` categories via server component; `POST /api/ideas/generate` (Task 7).
- Produces: a working generation UI.

- [ ] **Step 1: Server page fetching categories**

`app/(app)/generate/page.tsx`:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { GenerateForm } from "./generate-form";
import type { Category } from "@/lib/types";

export default async function GeneratePage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("categories").select("key,name").eq("active", true).order("key");
  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-2xl font-bold">Generate ideas</h1>
      <GenerateForm categories={(data ?? []) as Pick<Category, "key" | "name">[]} />
    </div>
  );
}
```

- [ ] **Step 2: Client form**

`app/(app)/generate/generate-form.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { Category } from "@/lib/types";

export function GenerateForm({ categories }: { categories: Pick<Category, "key" | "name">[] }) {
  const [categoryKey, setCategoryKey] = useState("ALL");
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const router = useRouter();

  async function generate() {
    setBusy(true); setResult(null);
    try {
      const res = await fetch("/api/ideas/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryKey, count }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setResult(`Inserted ${json.inserted} ideas (${json.filteredOut} filtered out).`);
      router.refresh();
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Category</Label>
        <Select value={categoryKey} onValueChange={setCategoryKey}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.key} value={c.key}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Number of ideas (max 10 recommended)</Label>
        <Input type="number" min={1} max={20} value={count}
          onChange={(e) => setCount(Number(e.target.value))} />
      </div>
      <Button onClick={generate} disabled={busy} className="w-full">
        {busy ? "Generating… (can take a minute)" : "Generate"}
      </Button>
      {result && <p className="text-sm">{result}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Live verification**

`npm run dev` → `/generate` → pick `SAT_MYTH`, count 2, click Generate. Expected: success message; rows visible in Supabase.

- [ ] **Step 4: Commit**

```bash
git add app/ && git commit -m "feat: generate page"
```

---

### Task 10: /ideas board with approve/reject

**Files:**
- Create: `app/(app)/ideas/page.tsx`, `app/(app)/ideas/idea-card.tsx`, `app/(app)/ideas/actions.ts`

**Interfaces:**
- Consumes: `ideas` + `categories` tables; auth.
- Produces: server actions `setIdeaDecision(id: string, decision: "approved" | "rejected"): Promise<void>` (sets `approved` bool + `status`), used by the card component. Phase 2's plan will add a "Generate images" button to this page.

- [ ] **Step 1: Server actions**

`app/(app)/ideas/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";

export async function setIdeaDecision(id: string, decision: "approved" | "rejected") {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== process.env.ALLOWED_EMAIL) throw new Error("unauthorized");

  const { error } = await supabase
    .from("ideas")
    .update({ approved: decision === "approved", status: decision })
    .eq("id", id)
    .in("status", ["pending_review", "approved", "rejected"]); // never clobber in-flight rows
  if (error) throw new Error(error.message);
  revalidatePath("/ideas");
}
```

- [ ] **Step 2: Board page (server component)**

`app/(app)/ideas/page.tsx`:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { IdeaCard } from "./idea-card";
import type { Idea } from "@/lib/types";

export default async function IdeasPage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("ideas").select("*").order("created_at", { ascending: false }).limit(200);
  const ideas = (data ?? []) as Idea[];

  const byCategory = new Map<string, Idea[]>();
  for (const idea of ideas) {
    byCategory.set(idea.category_key, [...(byCategory.get(idea.category_key) ?? []), idea]);
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Ideas</h1>
      {ideas.length === 0 && <p>No ideas yet — go to Generate.</p>}
      {[...byCategory.entries()].map(([key, group]) => (
        <section key={key} className="space-y-3">
          <h2 className="text-lg font-semibold">{key} ({group.length})</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.map((idea) => <IdeaCard key={idea.id} idea={idea} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Idea card (client component)**

`app/(app)/ideas/idea-card.tsx`:

```tsx
"use client";
import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { setIdeaDecision } from "./actions";
import type { Idea } from "@/lib/types";

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending_review: "outline", approved: "default", rejected: "destructive",
  generating: "secondary", generated: "default", posted: "secondary", failed: "destructive",
};

export function IdeaCard({ idea }: { idea: Idea }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const reviewable = ["pending_review", "approved", "rejected"].includes(idea.status);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <Badge variant={statusVariant[idea.status] ?? "outline"}>{idea.status}</Badge>
        {reviewable && (
          <div className="flex gap-1">
            <Button size="sm" variant={idea.approved ? "default" : "outline"} disabled={pending}
              onClick={() => startTransition(() => setIdeaDecision(idea.id, "approved"))}>
              ✓
            </Button>
            <Button size="sm" variant={idea.status === "rejected" ? "destructive" : "outline"}
              disabled={pending}
              onClick={() => startTransition(() => setIdeaDecision(idea.id, "rejected"))}>
              ✗
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <p className={`text-sm whitespace-pre-wrap ${expanded ? "" : "line-clamp-4"}`}>
          {idea.concept}
        </p>
        <button className="text-xs underline text-muted-foreground"
          onClick={() => setExpanded(!expanded)}>
          {expanded ? "collapse" : "expand"}
        </button>
        {idea.ai_filter_reason && (
          <p className="text-xs text-muted-foreground">AI filter: {idea.ai_filter_reason}</p>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Live verification**

`/ideas` shows the rows generated in Task 9; clicking ✓ flips badge to `approved`, ✗ to `rejected`; state persists after refresh and matches the DB.

- [ ] **Step 5: Commit**

```bash
git add app/ && git commit -m "feat: ideas board with approve/reject"
```

---

### Task 11: /config editor

**Files:**
- Create: `app/(app)/config/page.tsx`, `app/(app)/config/config-form.tsx`, `app/(app)/config/actions.ts`

**Interfaces:**
- Consumes: `categories` table; auth.
- Produces: server action `updateCategory(key: string, fields: {...}): Promise<void>` covering `name, style_guide, style_ref_url, post_caption, buffer_channel_id, buffer_account, images_per_carousel, aspect_ratio, active`.

- [ ] **Step 1: Server action**

`app/(app)/config/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";

export interface CategoryUpdate {
  name: string;
  style_guide: string;
  style_ref_url: string;
  post_caption: string;
  buffer_channel_id: string;
  buffer_account: number;
  images_per_carousel: number;
  aspect_ratio: string;
  active: boolean;
}

export async function updateCategory(key: string, fields: CategoryUpdate) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== process.env.ALLOWED_EMAIL) throw new Error("unauthorized");
  if (![1, 2].includes(fields.buffer_account)) throw new Error("buffer_account must be 1 or 2");
  if (fields.images_per_carousel < 1 || fields.images_per_carousel > 10) {
    throw new Error("images_per_carousel must be 1-10");
  }
  const { error } = await supabase.from("categories").update(fields).eq("key", key);
  if (error) throw new Error(error.message);
  revalidatePath("/config");
}
```

- [ ] **Step 2: Page + per-category form**

`app/(app)/config/page.tsx`:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { ConfigForm } from "./config-form";
import type { Category } from "@/lib/types";

export default async function ConfigPage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase.from("categories").select("*").order("key");
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Config</h1>
      {((data ?? []) as Category[]).map((c) => <ConfigForm key={c.key} category={c} />)}
    </div>
  );
}
```

`app/(app)/config/config-form.tsx`:

```tsx
"use client";
import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { updateCategory, type CategoryUpdate } from "./actions";
import type { Category } from "@/lib/types";

export function ConfigForm({ category }: { category: Category }) {
  const [form, setForm] = useState<CategoryUpdate>({
    name: category.name,
    style_guide: category.style_guide,
    style_ref_url: category.style_ref_url,
    post_caption: category.post_caption,
    buffer_channel_id: category.buffer_channel_id,
    buffer_account: category.buffer_account,
    images_per_carousel: category.images_per_carousel,
    aspect_ratio: category.aspect_ratio,
    active: category.active,
  });
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");

  function set<K extends keyof CategoryUpdate>(k: K, v: CategoryUpdate[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function save() {
    startTransition(async () => {
      try {
        await updateCategory(category.key, form);
        setMsg("Saved.");
      } catch (e) {
        setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{category.key}</CardTitle>
        <div className="flex items-center gap-3">
          <Switch checked={form.active} onCheckedChange={(v) => { set("active", v); }} />
          <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Edit"}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          <div><Label>Name</Label>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} /></div>
          <div><Label>Style guide</Label>
            <Textarea rows={10} value={form.style_guide}
              onChange={(e) => set("style_guide", e.target.value)} /></div>
          <div><Label>Style reference URL</Label>
            <Input value={form.style_ref_url}
              onChange={(e) => set("style_ref_url", e.target.value)} />
            {form.style_ref_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.style_ref_url} alt="style ref"
                className="mt-2 h-40 rounded border object-cover" />
            )}
          </div>
          <div><Label>Post caption</Label>
            <Textarea rows={3} value={form.post_caption}
              onChange={(e) => set("post_caption", e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Buffer channel ID</Label>
              <Input value={form.buffer_channel_id}
                onChange={(e) => set("buffer_channel_id", e.target.value)} /></div>
            <div><Label>Buffer account (1 or 2)</Label>
              <Input type="number" min={1} max={2} value={form.buffer_account}
                onChange={(e) => set("buffer_account", Number(e.target.value))} /></div>
            <div><Label>Images per carousel</Label>
              <Input type="number" min={1} max={10} value={form.images_per_carousel}
                onChange={(e) => set("images_per_carousel", Number(e.target.value))} /></div>
            <div><Label>Aspect ratio</Label>
              <Input value={form.aspect_ratio}
                onChange={(e) => set("aspect_ratio", e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
            <span className="text-sm text-muted-foreground">{msg}</span>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
```

- [ ] **Step 3: Live verification**

`/config` lists 5 categories with the seeded style guides; edit `post_caption` on one, Save, refresh — change persists and shows in Supabase.

- [ ] **Step 4: Commit**

```bash
git add app/ && git commit -m "feat: category config editor"
```

---

### Task 12: Deploy to Vercel (USER CHECKPOINT)

**Files:** none (config only).

**Interfaces:**
- Consumes: everything above.
- Produces: production URL; Phase 1 acceptance.

- [ ] **Step 1: Push to GitHub**

Ask the user for the GitHub repo (or create with `gh repo create athena-content-app --private --source=. --push`).

- [ ] **Step 2: Create the Vercel project**

Via Vercel dashboard (Import Git Repository) or `npx vercel link && npx vercel --prod`. Set all env vars from `.env.example` with real values (`ANTHROPIC_API_KEY`, Supabase trio, `CLAUDE_MODEL`, `ALLOWED_EMAIL`).

- [ ] **Step 3: Update Supabase auth URLs**

Supabase dashboard → Authentication → URL Configuration: set Site URL to the Vercel production URL and add `https://<prod-domain>/auth/confirm` to Redirect URLs (keep localhost too).

- [ ] **Step 4: Production acceptance check**

On the prod URL: log in via magic link → generate 2 ideas for one category → approve one, reject one → edit config field and save. All four must work.

- [ ] **Step 5: Commit any config artifacts and tag**

```bash
git add -A && git commit -m "chore: phase 1 complete" --allow-empty
git tag phase-1
```

---

## Self-Review Notes

- **Spec coverage (Phase 0+1 scope):** scaffold/deploy (T1, T12), schema §3 (T2), auth §2 (T4), seed §6-Phase 0 (T5), Claude integration §4 (T6, T7), /generate + /ideas + /config §5 (T9, T10, T11), shell (T8). Gallery/Post pages and Kie/Buffer/cron are Phases 2–3 (separate plans, per spec §6).
- **Type consistency:** `setIdeaDecision`, `updateCategory`, `generateIdeas`, and the zod schemas are named identically at definition and call sites; `CategoryUpdate` exported from actions and imported by the form.
- **Known deviation from spec:** filter criteria in the old n8n prompt started at "2." (a numbering bug in the original); the port renumbers 1–3 with identical content.
