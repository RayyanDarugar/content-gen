# Majordomo spend tracking for Claude calls

## Problem

Claude API spend is invisible per-feature today. The Anthropic client is constructed independently in 6 places, each pulling the calling user's own Anthropic key via `requireAnthropicKey` (this app is multi-tenant — every user brings their own Anthropic key, stored encrypted in Supabase). There's no shared client factory and no way to see which feature (brand analysis, caption rewriting, idea generation, ...) is driving spend.

[Majordomo](https://gomajordomo.com) is a spend-tracking gateway: point the SDK's `baseURL` at `https://gateway.gomajordomo.com`, add an `X-Majordomo-Key` header with an app-wide `mdm_sk_...` key, and any `X-Majordomo-*` header becomes queryable metadata in its dashboard. The real Anthropic key still passes through untouched — Majordomo doesn't replace per-user auth, it observes it.

## Goals

- Centralize Anthropic client construction into one factory so Majordomo config lives in one place, not duplicated 6x.
- Tag every Claude call with a feature name so spend is attributable per product surface.
- Zero behavior change when Majordomo isn't configured (e.g. local dev without a Majordomo key) — calls go straight to Anthropic.

## Non-goals

- Team/user-tier/experiment metadata dimensions — only `Feature` and `Environment` for now.
- Self-hosted Majordomo gateway — using the hosted `gateway.gomajordomo.com` endpoint.
- Changing per-user Anthropic key storage/handling.

## Design

### `lib/anthropic.ts` (new)

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
      "X-Majordomo-Environment": process.env.VERCEL_ENV || "development", // "||" not "??" — VERCEL_ENV is "" (empty string, not undefined) in local dev, and "??" would leave it as "" instead of falling back
    },
  });
}
```

When `MAJORDOMO_API_KEY` is unset, this returns a plain client identical to what every call site constructs today — tracking is strictly additive and optional.

### Env vars

- `.env.example`: add `MAJORDOMO_API_KEY=` (blank).
- `.env.local`: add the real key (`mdm_sk_...`), not committed.

### Call site changes

Replace `new Anthropic({ apiKey: await requireAnthropicKey(...), ... })` with `createAnthropicClient({ apiKey: await requireAnthropicKey(...), feature: "...", maxRetries: ... })` in all 6 files. `maxRetries` values are preserved as-is; no other logic changes.

| File | Feature tag(s) |
|---|---|
| `app/api/posts/rewrite-caption/route.ts` | `post_caption_rewrite` |
| `app/api/posts/adapt-caption/route.ts` | `post_caption_adapt` |
| `app/api/categories/draft/route.ts` | `category_draft` |
| `app/api/brand/extract/route.ts` | `brand_analysis` |
| `lib/athena/generate-ideas.ts` | `content_idea_generation` (idea-generation call), `content_idea_filter` (filter call) — two separate Claude calls in this file, tagged separately |
| `lib/athena/preview.ts` | `content_preview` |

## Testing

- `tests/llm-errors.test.ts` and `tests/draft-category.test.ts` don't construct a real Anthropic client against the network, so they're unaffected by the factory swap.
- Manual check: with `MAJORDOMO_API_KEY` unset locally, exercise one call site (e.g. rewrite-caption) and confirm it still works unchanged.
- Manual check: with `MAJORDOMO_API_KEY` set, exercise a couple of call sites and confirm requests appear in the Majordomo dashboard tagged with the right `Feature`.
