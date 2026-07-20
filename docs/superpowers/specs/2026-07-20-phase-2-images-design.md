# Athena Content App — Phase 2 Design: Image Generation + Gallery

**Date:** 2026-07-20
**Status:** Pending user review
**Parent spec:** `2026-07-20-athena-content-app-design.md` (§2 architecture, §3 data model, §4 Kie integration all still govern; this doc resolves Phase 2's deferred decisions and pins the exact Kie mechanics extracted from n8n Workflow B)

## 1. Scope

Approved ideas become images: submit to Kie.ai (GPT-Image-2 image-to-image), poll via cron until done, ingest into Supabase Storage, view in a live-updating gallery with retry-on-failure and regenerate-with-notes. Ends with the `/gallery` nav link becoming a real page. Posting (Phase 3) remains out of scope.

## 2. Decisions resolved (user-confirmed 2026-07-20)

| Decision | Choice |
|---|---|
| Cron source | **cron-job.org** free account pinging `GET /api/jobs/poll` every 60s with `Authorization: Bearer ${CRON_SECRET}`. One-time user setup at the deploy checkpoint. |
| Storage format | **JPEG quality 90** via `sharp` on ingest (~5-10× smaller than Kie's PNG; ~4,000+ images in the 1GB free tier; universally accepted downstream). Stored at `images/{generation_id}.jpg` in a public bucket. |
| Refinement | **Included.** Completed images get "Regenerate with notes" (notes appended to the prompt, new generation row, history kept). Failed generations get "Retry". |

## 3. Kie.ai mechanics (ported verbatim from Workflow B)

Auth: `Authorization: Bearer ${KIE_API_KEY}` on all three endpoints.

1. **Style ref upload** — `POST https://kieai.redpandaai.co/api/file-url-upload`, JSON body `{fileUrl: <category.style_ref_url>, uploadPath: "athena-refs", fileName: "style_ref.jpg"}` → response `data.downloadUrl` (throw if absent). Uploaded **once per category per submit batch** (improvement over n8n, which re-uploaded per item); no DB caching — style_ref_url edits always take effect next batch.
2. **Submit** — `POST https://api.kie.ai/api/v1/jobs/createTask`, body `{model: "gpt-image-2-image-to-image", input: {prompt: fullPrompt, input_urls: [downloadUrl], aspect_ratio: category.aspect_ratio}}` → `data.taskId` (throw if absent).
3. **Poll** — `GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=...` → `data.state`: `"success"` → parse `data.resultJson` (JSON string) → `resultUrls[0]` = image URL; `"fail"` → failed; anything else → still pending.

**Prompt composition** (identical to n8n `Build Kie Request` + refinement from `Merge and Resolve Items`):
```
{category.style_guide}

SPECIFIC CONTENT FOR THIS IMAGE:
{idea.resolved_prompt}[\n\nRefinement notes: {generation.refinement_notes}]

Reference the provided style image to maintain visual consistency in palette, illustration style, and layout.
```

## 4. Schema changes (migration 0003)

- `generations.refinement_notes text not null default ''` — notes belong to the attempt they shaped, not the idea.
- Public storage bucket `images` (`insert into storage.buckets (id, name, public) values ('images','images',true)`). Writes go through the service-role client only; public read via URL is the point (Buffer needs it in Phase 3). No storage RLS policies needed.
- `alter publication supabase_realtime add table generations;` — enables the gallery's live status updates.
- Applied by the user via SQL editor (same checkpoint pattern as 0001/0002).

## 5. Flows

### Submit — `POST /api/images/generate` (auth: `requireAllowedUser`)
Body `{ideaIds: string[]}` (from the ideas board's "Generate images" button over approved ideas) **or** `{ideaId, refinementNotes?}` (gallery retry/regenerate). For each idea: verify status is eligible (`approved`/`failed` for fresh+retry; `generated` allowed when refinementNotes present), upload style ref (once per category in the batch), compose prompt, `createTask`, insert `generations` row (`status='submitted'`, `kie_task_id`, `full_prompt`, `kie_style_url`, `refinement_notes`), set idea `status='generating'`. Per-idea failures recorded (`generations.status='failed'` with error) without aborting the rest of the batch. `maxDuration = 120`.

### Poll — `GET /api/jobs/poll` (auth: constant-time compare of `Authorization: Bearer ${CRON_SECRET}`; NOT `requireAllowedUser` — no session)
For every generation in (`submitted`,`polling`): call `recordInfo`.
- pending → `status='polling'`, `poll_count += 1`; at `poll_count >= 20` → `failed` (`error='poll cap reached'`), idea → `failed`.
- `fail` → generation `failed` + error, idea → `failed`.
- `success` → download `resultUrls[0]`, `sharp` → JPEG q90, upload to `images/{generation_id}.jpg` (upsert), set `image_path`+`public_url`, generation `succeeded`, idea → `generated`.
**Bounded work per tick:** poll status checks are cheap (all pending rows each tick), but full ingestion (download+convert+upload) is capped at **5 per tick** — the rest stay `success`-pending and ingest next tick. Keeps the function well inside limits at any batch size. Idempotent under double-fire (re-ingest overwrites the same path/row identically). Returns JSON summary `{polled, ingested, failed}` for cron-job.org's log.

### Gallery — `/gallery`
Server component: ideas with their **latest generation** (by `created_at`), grouped by category, filterable client-side by status. Card: image (or status spinner/error), concept snippet, generation timestamps. Actions: **Retry** (visible when latest generation `failed`) and **Regenerate with notes…** (dialog with textarea, visible when `succeeded`) — both call `POST /api/images/generate`. Older generations accessible in a per-idea history dialog (small: list of past attempts with thumbnails). **Live updates:** client component subscribes to Supabase Realtime on `generations` and calls `router.refresh()` on any change (simple, correct; no client-side cache merging).

**Phase 3 contract:** the postable image for an idea = its latest `succeeded` generation. (Noted here so Phase 3's plan doesn't have to re-derive it.)

## 6. Ideas board addition

Per-category "Generate images (N)" button appears when a category has approved ideas; posts their ids to `/api/images/generate`; board reflects `generating` status via existing revalidation.

## 7. Error handling

- All Kie/network failures land on the affected `generations.error` and surface on the gallery card — no silent failures (parent spec §7).
- The poll route never throws for a single bad row: per-row try/catch, row marked failed, tick continues.
- `sharp` conversion failure → generation `failed` with error (rare; image re-downloadable via retry).

## 8. New env / deps / user checkpoints

- `CRON_SECRET` — generated during implementation (random 32 bytes hex), added to `.env.local` + Vercel.
- New dependency: `sharp`.
- User checkpoints: (1) apply migration 0003 via SQL editor; (2) create cron-job.org job (exact instructions provided at that task); (3) production acceptance: approve idea → generate → watch gallery go submitted→polling→image → regenerate with notes → confirm second image.

## 9. Testing

- Unit (vitest): prompt composition incl. refinement notes; poll-state transition logic (pending/fail/success/poll-cap) extracted as a pure function; ingestion-cap batching selection.
- Live verification per phase pattern: one real 1-image run against Kie in production (costs pennies), realtime update observed in gallery.

## 10. Out of scope

Buffer posting (`/post`), engagement analytics, deleting images from storage (until storage pressure warrants), multi-image-per-idea variants.
