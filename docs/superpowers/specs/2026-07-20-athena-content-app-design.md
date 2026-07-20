# Athena Content App — Design Spec

**Date:** 2026-07-20
**Status:** Approved direction; pending final user review
**Replaces:** The three n8n workflows (Athena A/B/C) + Google Sheets + Google Drive + Cloudinary

## 1. Summary

A single Next.js website, hosted on Vercel, that runs the entire Athena content pipeline: generate content ideas per category with Claude, review/approve them in a UI, generate images via Kie.ai (GPT-Image-2 image-to-image), view results in a gallery, and post finished carousels to TikTok via Buffer — all backed by Supabase. n8n, Google Sheets, Google Drive, and Cloudinary are fully retired.

Single user (Rayyan), authenticated via Supabase magic-link to `rdarugar@usc.edu`.

## 2. Architecture

```
Next.js 15 (App Router, TypeScript, Tailwind + shadcn/ui) on Vercel
├─ Pages: /config · /generate · /ideas · /gallery · /post
├─ API routes (server-only, hold all secrets):
│    POST /api/ideas/generate    → Claude: idea gen + self-filter   (replaces Workflow A)
│    POST /api/images/generate   → Kie style-ref upload + createTask (replaces Workflow B submit)
│    GET  /api/jobs/poll         → Kie recordInfo → download image → Supabase Storage (replaces Workflow B poll loop)
│    POST /api/posts/create      → group carousel → Buffer GraphQL   (replaces Workflow C)
├─ Cron: external free pinger (cron-job.org) hits /api/jobs/poll every 60s,
│    authenticated with a CRON_SECRET header. (Upgrade path: Vercel Pro cron.)
└─ Supabase
     ├─ Postgres  — categories, ideas, generations, posts, post_images
     ├─ Storage   — generated images (public bucket → public URLs Buffer can fetch)
     ├─ Auth      — magic-link, allowlist rdarugar@usc.edu only
     └─ Realtime  — live status updates on the Ideas board and Gallery
```

Key decisions already made:
- **Full rebuild** — n8n retired, no hybrid.
- **Supabase** for DB + storage + auth + realtime.
- **Supabase Storage replaces Cloudinary and Google Drive.** Generated images are stored once, and their public URLs are used both for UI display and for the Buffer post payload.
- **The Kie poll loop becomes stateless**: a `generations` table holds pending `kie_task_id`s; each cron tick polls all pending tasks via `recordInfo`, ingests finished images, marks failures after a poll cap (matching the n8n behavior of ~20 polls).
- **Engagement analytics deferred to v2.**

## 3. Data model (Supabase Postgres)

All tables have `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at`.

### categories
Replaces the Config sheet **and** the maps hardcoded in n8n code nodes (`CHANNEL_MAP`, `IMAGES_PER_CATEGORY`).

| column | type | notes |
|---|---|---|
| key | text unique | e.g. `SAT_MYTH`, `COMIC`, `NOTES_APP`, `BRAIN_TEASER`, `BEAGLE_EXPLAINS` |
| name | text | display name |
| style_guide | text | long-form style guide (markdown) |
| style_ref_url | text | public URL of the style reference image |
| post_caption | text | caption used for Buffer posts |
| buffer_channel_id | text | TikTok channel id in Buffer |
| buffer_account | int | 1 or 2 (which Buffer account/token to use) |
| images_per_carousel | int | 5 default; 1 for NOTES_APP |
| aspect_ratio | text | default `4:5` (current pipeline value) |
| active | bool | hide without deleting |

Seeded from the existing Config sheet + the two n8n maps.

### ideas
Replaces the Staging sheet.

| column | type | notes |
|---|---|---|
| category_key | text fk → categories.key | |
| concept | text | the idea summary |
| resolved_prompt | text | full prompt for image gen |
| ai_filter_reason | text | Claude's self-filter rationale |
| approved | bool | default false (was `your_approval`) |
| status | text enum | `pending_review → approved → generating → generated → posted`, or `rejected`, `failed` |
| batch_id | uuid | groups ideas created in one generation run |

### generations
One row per Kie attempt (retries create new rows, history preserved).

| column | type | notes |
|---|---|---|
| idea_id | uuid fk → ideas | |
| kie_task_id | text | from `createTask` |
| status | text enum | `submitted → polling → succeeded / failed` |
| poll_count | int | fail after 20 polls (parity with n8n) |
| kie_style_url | text | Kie-side uploaded style ref URL |
| full_prompt | text | style_guide + resolved_prompt composite actually sent |
| image_path | text | Supabase Storage path |
| public_url | text | public URL of stored image |
| error | text | failure detail |

### posts + post_images

| posts column | type | notes |
|---|---|---|
| category_key | text fk | |
| buffer_update_id | text | returned by Buffer |
| caption | text | snapshot of caption used |
| status | text enum | `created → queued / failed` |

`post_images`: `post_id fk`, `generation_id fk`, `sort_order int`.

Row-level security: all tables locked to the authenticated user; API routes use the service-role key server-side.

## 4. External integrations (ported from n8n verbatim where possible)

### Claude (idea generation) — `/api/ideas/generate`
- TypeScript SDK `@anthropic-ai/sdk`, server-side only.
- Model: env `CLAUDE_MODEL`, default `claude-opus-4-8`. Adaptive thinking (`thinking: {type: "adaptive"}`); streaming with `.finalMessage()`.
- System prompt: ported from the n8n **Build Claude Prompt Request** node (brand rules, Beagle mascot, parent audience, category style guides pulled from `categories`).
- Two-step flow preserved: (1) generate N ideas per selected category, (2) self-filter pass (ported from **Build Filter Request** / **Merge Filter Decisions**); only AI-approved ideas are inserted, with `ai_filter_reason`.
- Structured outputs (`output_config.format` with a JSON schema) replace the fragile "Parse Ideas JSON" step.

### Kie.ai (image generation) — `/api/images/generate` + `/api/jobs/poll`
- Style-ref upload: `POST https://kieai.redpandaai.co/api/file-url-upload` (as in **Upload Style Ref**), result cached on the generation row.
- Submit: `POST https://api.kie.ai/api/v1/jobs/createTask` with body `{model: "gpt-image-2-image-to-image", input: {prompt: fullPrompt, input_urls: [styleUrl], aspect_ratio}}` — identical to **Build Kie Request**.
- `fullPrompt` = style_guide + "\n\nSPECIFIC CONTENT FOR THIS IMAGE:\n" + resolved_prompt + consistency suffix (verbatim port).
- Poll: `GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=...` per pending row per cron tick (~60s; n8n used 45s — Kie takes 1–5 min/image so this is fine). On success: download image server-side, upload to Supabase Storage, set `public_url`, mark idea `generated`. After 20 failed polls: mark `failed` with error.
- Rate pacing: submit sequentially (Kie generates one at a time anyway, per current behavior).

### Buffer (posting) — `/api/posts/create`
- Port of Workflow C: select `generated` + approved images for a category, require exactly `images_per_carousel` images, build the same GraphQL carousel mutation (image URLs now Supabase public URLs), route to `BUFFER_TOKEN_1` or `BUFFER_TOKEN_2` by `categories.buffer_account`, POST to `https://api.buffer.com`.
- On success: create `posts` row with `buffer_update_id`, mark ideas/generations `posted`.
- Partial sets are blocked in the UI (same guard as **Group Into Carousels**).

## 5. UI pages

- **/config** — table of categories; edit style guide (markdown textarea), caption, style_ref_url (with image preview), Buffer routing, images_per_carousel, active toggle.
- **/generate** — pick category (or All) + count (max ~10, same guidance as n8n), hit Generate; progress state; results land on Ideas board.
- **/ideas** — board grouped by category and status; each card: concept, expandable full prompt, filter reason, approve/reject toggle; bulk approve; "Generate images" button for approved ideas.
- **/gallery** — grid of generations with live status (Realtime): submitted/polling spinner, final image, error + Retry button on failures; filter by category/status.
- **/post** — per category: shows ready sets (n of images_per_carousel), caption preview, "Post to Buffer" button; history of posted carousels with Buffer ids.

Layout: simple sidebar nav, dark-mode friendly, shadcn/ui components. This is a single-user internal tool — function over polish, but not ugly.

## 6. Phases

- **Phase 0 — Foundation:** scaffold Next.js + Tailwind + shadcn; Supabase project, schema migration, storage bucket, auth allowlist; seed categories from the xlsx Config sheet + n8n maps; env wiring; deploy to Vercel.
- **Phase 1 — Config + Ideas:** /config editor; /api/ideas/generate; /generate + /ideas pages with approve flow.
- **Phase 2 — Images:** /api/images/generate, /api/jobs/poll + cron setup; /gallery with realtime status and retry.
- **Phase 3 — Posting:** /api/posts/create; /post page; end-to-end verification with a real Buffer queue post.
- **v2 (out of scope):** Buffer engagement analytics dashboard.

Each phase is independently usable and verified end-to-end before the next starts.

## 7. Error handling

- Every external call wrapped with typed error capture; failures written to the relevant row (`error` column) and surfaced in the UI — no silent failures.
- Kie failures: bounded by poll cap; Retry creates a fresh `generations` row.
- Buffer failures: post row marked `failed` with response body; images remain postable.
- Cron endpoint: requires `Authorization: Bearer ${CRON_SECRET}`; idempotent (safe to double-fire).
- Claude structured outputs eliminate JSON-parse failures; refusal/max_tokens stop reasons checked before reading content.

## 8. Secrets / env vars (user provides at Phase 0)

| var | purpose |
|---|---|
| ANTHROPIC_API_KEY | idea generation |
| CLAUDE_MODEL | default `claude-opus-4-8` |
| KIE_API_KEY | image generation |
| BUFFER_TOKEN_1 / BUFFER_TOKEN_2 | posting, per Buffer account |
| NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY | client |
| SUPABASE_SERVICE_ROLE_KEY | server API routes |
| CRON_SECRET | poll endpoint auth |

## 9. Testing / verification

- Unit tests for pure logic: carousel grouping, Buffer routing, prompt composition, poll-state transitions (vitest).
- Each API route verified against the real service once per phase (small N, cheap calls) before UI wiring is called done.
- Phase 3 acceptance: one real carousel queued in Buffer, visible in the Buffer dashboard, rows marked `posted`.

## 10. Migration notes

- Existing Staging/Review sheet rows are **not** migrated — the pipeline is batch-oriented and history lives in the old sheet if ever needed. Only Config is seeded.
- n8n workflows stay untouched until Phase 3 is verified, then can be deactivated.
