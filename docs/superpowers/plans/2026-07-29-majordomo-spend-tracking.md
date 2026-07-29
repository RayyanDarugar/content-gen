# Majordomo Spend Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Claude API calls through the Majordomo spend-tracking gateway, tagged per feature, with zero behavior change when Majordomo isn't configured.

**Architecture:** One new shared factory (`lib/anthropic.ts`) replaces the 6 independent `new Anthropic(...)` call sites. The factory conditionally adds Majordomo's gateway `baseURL` and `X-Majordomo-*` headers based on whether `MAJORDOMO_API_KEY` is set; when it's unset, it returns a client identical to what's constructed today.

**Tech Stack:** Next.js API routes, `@anthropic-ai/sdk` (v0.112), vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-majordomo-spend-tracking-design.md`
- Majordomo gateway base URL: `https://gateway.gomajordomo.com` (exact, no trailing slash).
- Metadata header prefix: `X-Majordomo-` — only `X-Majordomo-Key`, `X-Majordomo-Feature`, `X-Majordomo-Environment` are used (no Team/User-Id/Experiment dimensions).
- When `MAJORDOMO_API_KEY` is unset, calls MUST go straight to `https://api.anthropic.com` (the SDK's own default) with no `X-Majordomo-*` headers — tracking is strictly additive, never a hard dependency.
- Never write the real Majordomo key value into any file that gets committed (plan docs, specs, source, `.env.example`) — only into the untracked `.env.local`.
- Existing `maxRetries` values per call site must be preserved exactly (`brand/extract`: 5, `generate-ideas`: 5, all others: SDK default).

---

### Task 1: Anthropic client factory with Majordomo integration

**Files:**
- Create: `lib/anthropic.ts`
- Create: `tests/anthropic.test.ts`
- Modify: `vitest.config.ts` (alias `server-only` to its no-op export so unit tests can import server-only modules — Next.js does this automatically via webpack, vitest needs it added explicitly)
- Modify: `.env.example` (document the new var)

**Interfaces:**
- Produces: `createAnthropicClient(opts: { apiKey: string; feature: string; maxRetries?: number }): Anthropic` — exported from `lib/anthropic.ts`. Task 2's 6 call sites import this function.

- [ ] **Step 1: Add the `server-only` alias to vitest config**

`lib/anthropic.ts` will import `"server-only"` (matching the existing convention in `lib/settings/user-secrets.ts`, `lib/athena/generate-ideas.ts`, `lib/athena/preview.ts`). That package's default export throws unconditionally outside a `react-server` condition — Next.js's webpack build remaps it to a no-op automatically, but vitest (plain Node) won't unless told to. Add the alias now so Step 3 fails for the *right* reason (missing module), not this one.

Edit `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
});
```

- [ ] **Step 2: Write the failing test**

Create `tests/anthropic.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "@/lib/anthropic";

async function headersFor(client: ReturnType<typeof createAnthropicClient>) {
  const { req } = await client.buildRequest({ method: "post", path: "/v1/messages", body: {} });
  return req.headers as Headers;
}

describe("createAnthropicClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls the Anthropic API directly when MAJORDOMO_API_KEY is unset", async () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "");
    const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis" });
    expect(client.baseURL).toBe("https://api.anthropic.com");
    const headers = await headersFor(client);
    expect(headers.has("x-majordomo-key")).toBe(false);
  });

  it("routes through the Majordomo gateway tagged with feature and environment when MAJORDOMO_API_KEY is set", async () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "mdm_sk_test");
    vi.stubEnv("VERCEL_ENV", "production");
    const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis" });
    expect(client.baseURL).toBe("https://gateway.gomajordomo.com");
    const headers = await headersFor(client);
    expect(headers.get("x-majordomo-key")).toBe("mdm_sk_test");
    expect(headers.get("x-majordomo-feature")).toBe("brand_analysis");
    expect(headers.get("x-majordomo-environment")).toBe("production");
  });

  it("defaults X-Majordomo-Environment to \"development\" when VERCEL_ENV is unset", async () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "mdm_sk_test");
    vi.stubEnv("VERCEL_ENV", "");
    const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis" });
    const headers = await headersFor(client);
    expect(headers.get("x-majordomo-environment")).toBe("development");
  });

  it("passes maxRetries through in both modes", () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "");
    const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis", maxRetries: 5 });
    expect(client.maxRetries).toBe(5);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/anthropic.test.ts`
Expected: FAIL — `Cannot find module '@/lib/anthropic'` (the module doesn't exist yet).

- [ ] **Step 4: Implement the factory**

Create `lib/anthropic.ts`:

```ts
import "server-only";
import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicClient(opts: {
  apiKey: string;
  feature: string;
  maxRetries?: number;
}): Anthropic {
  const majordomoKey = process.env.MAJORDOMO_API_KEY;
  if (!majordomoKey) {
    return new Anthropic({ apiKey: opts.apiKey, maxRetries: opts.maxRetries });
  }
  return new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: opts.maxRetries,
    baseURL: "https://gateway.gomajordomo.com",
    defaultHeaders: {
      "X-Majordomo-Key": majordomoKey,
      "X-Majordomo-Feature": opts.feature,
      "X-Majordomo-Environment": process.env.VERCEL_ENV || "development",
    },
  });
}
```

Note the fallback uses `||`, not `??` — `VERCEL_ENV` is `""` (empty string, not `undefined`) in local dev, and `?? "development"` would leave it as `""` instead of falling back.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/anthropic.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Document the env var**

Add to `.env.example`, near the other Phase-labeled additions:

```
# Majordomo spend tracking (optional — calls go direct to Anthropic if unset)
MAJORDOMO_API_KEY=
```

Then add the real key to your own `.env.local` (untracked — do not put the actual value in any file that gets committed).

- [ ] **Step 7: Commit**

```bash
git add lib/anthropic.ts tests/anthropic.test.ts vitest.config.ts .env.example
git commit -m "feat: add Majordomo-aware Anthropic client factory"
```

---

### Task 2: Wire the 6 Claude call sites through the factory

**Files:**
- Modify: `app/api/posts/rewrite-caption/route.ts:2,78`
- Modify: `app/api/posts/adapt-caption/route.ts:2,62`
- Modify: `app/api/categories/draft/route.ts:2,90`
- Modify: `app/api/brand/extract/route.ts:2,97`
- Modify: `lib/athena/generate-ideas.ts:2,37,71,109`
- Modify: `lib/athena/preview.ts:2,54`

**Interfaces:**
- Consumes: `createAnthropicClient(opts: { apiKey: string; feature: string; maxRetries?: number }): Anthropic` from `@/lib/anthropic` (Task 1).

Each edit below replaces the bare `import Anthropic from "@anthropic-ai/sdk";` with `import { createAnthropicClient } from "@/lib/anthropic";`, and swaps the `new Anthropic({...})` call for `createAnthropicClient({...})` with a feature tag. `Anthropic` itself is no longer referenced in these files after the edit (its only use was the constructor), so the old import is removed rather than kept alongside.

- [ ] **Step 1: `app/api/posts/rewrite-caption/route.ts`**

Change line 2 from:
```ts
import Anthropic from "@anthropic-ai/sdk";
```
to:
```ts
import { createAnthropicClient } from "@/lib/anthropic";
```

Change line 78 from:
```ts
    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id) });
```
to:
```ts
    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "post_caption_rewrite",
    });
```

- [ ] **Step 2: `app/api/posts/adapt-caption/route.ts`**

Change line 2 from:
```ts
import Anthropic from "@anthropic-ai/sdk";
```
to:
```ts
import { createAnthropicClient } from "@/lib/anthropic";
```

Change line 62 from:
```ts
    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id) });
```
to:
```ts
    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "post_caption_adapt",
    });
```

- [ ] **Step 3: `app/api/categories/draft/route.ts`**

Change line 2 from:
```ts
import Anthropic from "@anthropic-ai/sdk";
```
to:
```ts
import { createAnthropicClient } from "@/lib/anthropic";
```

Change line 90 from:
```ts
    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id) });
```
to:
```ts
    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "category_draft",
    });
```

- [ ] **Step 4: `app/api/brand/extract/route.ts`**

Change line 2 from:
```ts
import Anthropic from "@anthropic-ai/sdk";
```
to:
```ts
import { createAnthropicClient } from "@/lib/anthropic";
```

Change line 97 from:
```ts
    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id), maxRetries: 5 });
```
to:
```ts
    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "brand_analysis",
      maxRetries: 5,
    });
```

- [ ] **Step 5: `lib/athena/generate-ideas.ts`**

This file makes two separate Claude calls (idea generation, then a self-filter pass) off one client today — it needs two differently-tagged clients instead. The surrounding comment (lines 31-36) explaining the `maxRetries: 5` rationale stays; it applies to both.

Change line 2 from:
```ts
import Anthropic from "@anthropic-ai/sdk";
```
to:
```ts
import { createAnthropicClient } from "@/lib/anthropic";
```

Change line 37 from:
```ts
  const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(userId), maxRetries: 5 });
```
to:
```ts
  const apiKey = await requireAnthropicKey(userId);
  const anthropicIdeas = createAnthropicClient({ apiKey, feature: "content_idea_generation", maxRetries: 5 });
  const anthropicFilter = createAnthropicClient({ apiKey, feature: "content_idea_filter", maxRetries: 5 });
```

Change line 71 (inside the "Call 1: generate ideas" block) from:
```ts
  const genResponse = await anthropic.messages.parse({
```
to:
```ts
  const genResponse = await anthropicIdeas.messages.parse({
```

Change line 109 (inside the "Call 2: self-filter" block) from:
```ts
  const filterResponse = await anthropic.messages.parse({
```
to:
```ts
  const filterResponse = await anthropicFilter.messages.parse({
```

- [ ] **Step 6: `lib/athena/preview.ts`**

Change line 2 from:
```ts
import Anthropic from "@anthropic-ai/sdk";
```
to:
```ts
import { createAnthropicClient } from "@/lib/anthropic";
```

Change line 54 from:
```ts
  const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(userId) });
```
to:
```ts
  const anthropic = createAnthropicClient({
    apiKey: await requireAnthropicKey(userId),
    feature: "content_preview",
  });
```

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing tests plus `tests/anthropic.test.ts` from Task 1 (this task doesn't add new test files: these 6 files are Next.js route/lib functions requiring live Supabase/Anthropic calls, which the project doesn't unit test directly today; verification here is the compile check below plus the manual smoke test).

- [ ] **Step 8: Type-check via build**

Run: `npm run build`
Expected: Succeeds with no TypeScript errors — specifically, no lingering references to the removed `Anthropic` default import (e.g. `Anthropic.APIError` isn't used in these 6 files; confirm with `grep -n "Anthropic\." app/api/posts/rewrite-caption/route.ts app/api/posts/adapt-caption/route.ts app/api/categories/draft/route.ts app/api/brand/extract/route.ts lib/athena/generate-ideas.ts lib/athena/preview.ts` — every remaining hit should be `anthropic.messages.parse` / `anthropicIdeas.messages.parse` / `anthropicFilter.messages.parse`, lowercase, never the capitalized class).

- [ ] **Step 9: Manual smoke test**

With `MAJORDOMO_API_KEY` unset (or commented out) in `.env.local`: run `npm run dev`, exercise one call site (e.g. rewrite a post caption), confirm it works exactly as before.

Then set `MAJORDOMO_API_KEY` in `.env.local`, restart the dev server, exercise 2-3 call sites (e.g. brand extraction and a caption rewrite), and confirm the requests show up in the Majordomo dashboard tagged with the right `Feature` values (`brand_analysis`, `post_caption_rewrite`, etc).

- [ ] **Step 10: Commit**

```bash
git add app/api/posts/rewrite-caption/route.ts app/api/posts/adapt-caption/route.ts app/api/categories/draft/route.ts app/api/brand/extract/route.ts lib/athena/generate-ideas.ts lib/athena/preview.ts
git commit -m "feat: tag all Claude calls with Majordomo feature metadata"
```
