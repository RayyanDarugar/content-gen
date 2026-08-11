# Image Download and Password Reset (Project D) — Design Spec

**Date:** 2026-08-11
**Status:** approved for planning
**Depends on:** `publishedImageUrl` (`lib/athena/published-image.ts`, from B1); `buildSlideView` (`lib/athena/slide-view.ts`); `requireUser` (`lib/auth/require-user.ts`); the existing Supabase SSR clients.

## 1. Summary

Two small, unrelated features, kept in one spec because each is too small for its own and they are independently reviewable:

1. **Download generated images** — per slide, and a whole carousel as a zip.
2. **Password reset** — the flow does not exist at all today.

They share no files, no types and no concepts. Either could be dropped without touching the other.

## 2. Download: the source is the *published* image

Downloads serve `publishedImageUrl(gen)` — `composited_url || public_url` — so what lands on disk is the image with its QR code, logo and speaker photo composited on, not the clean anchor the model was fed. Getting this backwards would hand someone a file that looks nothing like what published.

This is the same chokepoint every display and posting path already goes through (B1 §3). Download is a display path.

## 3. Per-image: a pure URL transform

Cloudinary sets `Content-Disposition: attachment` when `fl_attachment` appears in the delivery URL, so no route, no proxy and no buffering is needed — the browser downloads straight from the CDN.

```ts
attachmentUrl(url: string, filename?: string): string
```

`https://res.cloudinary.com/<cloud>/image/upload/v1/x.jpg`
→ `https://res.cloudinary.com/<cloud>/image/upload/fl_attachment/v1/x.jpg`

**Anything that is not a recognisable Cloudinary upload URL is returned unchanged.** A data URI, a URL from another host, or an empty string passes through rather than being mangled into something broken — the download then simply behaves as a normal link. This is the function's only real edge case and it is what the tests pin.

When a filename is supplied it becomes `fl_attachment:<slug>`, so the saved file is named after the post rather than a Cloudinary public id. The slug is restricted to `[A-Za-z0-9_-]` — Cloudinary's transformation segment is delimited by `/` and `,`, so an unsanitised concept string would corrupt the URL.

## 4. Whole carousel: a zip route

`GET /api/posts/[ideaId]/download` — resolves the idea's succeeded generations in `slide_index` order, fetches each published URL, and streams a zip named after the concept.

- Auth via `requireUser()`; the idea is loaded filtered by `id` **and** `user_id`.
- Slide selection reuses `buildSlideView`, so the zip contains exactly the slides the Gallery shows as current — not superseded retries.
- Entries are named `01.jpg`, `02.jpg`, … so they sort correctly in a file manager.
- A slide whose fetch fails is **skipped, and the zip still returns**, with the failure logged. A partial download beats a 500 when four of five images are fine.
- If *no* slide can be fetched, the route returns 502 rather than an empty zip, which would look like success.

**New dependency: `jszip`.** Node has no built-in zip, and Cloudinary's archive API needs a signed request — this project holds only an *unsigned* upload preset (`lib/cloudinary.ts`), no API secret, so that route is closed.

## 5. Password reset

None of this exists today. Signup is invite-code gated and establishes a session directly (`app/signup/actions.ts`), so there is currently no email anywhere in the auth flow.

Three pieces:

- **`app/auth/callback/route.ts`** — exchanges the emailed `code` for a session, then redirects to a `next` param (defaulting to `/ideas`). `next` is accepted **only if it is a relative path beginning with `/`**, so the callback cannot be turned into an open redirect.
- **`app/auth/update-password/page.tsx`** — a form behind `requireUser()`, calling `supabase.auth.updateUser({ password })`. The guard matters: it is the recovery session established by the callback that authorises the change.
- **"Forgot password?" on the login page** — collects an email and calls `resetPasswordForEmail(email, { redirectTo: <origin>/auth/callback?next=/auth/update-password })`.

**The response must not reveal whether an account exists.** The confirmation reads the same either way — "If that email has an account, a reset link is on its way" — matching how `signUp` already declines to leak registration state (see its comment at `app/signup/actions.ts:22-27`).

### Delivery is deliberately unresolved

This project has no SMTP configured. Supabase ships a default auth mailer that is heavily rate-limited and prone to spam folders; for a team of three resetting a password twice a year it may simply work, and that is cheaper to test than to design around.

So this ships the standard flow and we try it. **If delivery proves unusable, only the trigger changes** — the callback route and the update-password page are what every alternative needs too (an admin-generated recovery link, or custom SMTP later). Nothing here is wasted by that outcome.

**One config item lives outside the code:** the `redirectTo` URL must be added to the Supabase project's allowed redirect list, or the link bounces. That is a dashboard setting, not a code change.

## 6. Testing

- **`attachmentUrl`** — a Cloudinary upload URL gains `fl_attachment`; a filename becomes `fl_attachment:<slug>`; an unsafe filename is sanitised; a non-Cloudinary URL, a data URI and an empty string all pass through unchanged.
- **The zip route's slide selection and naming** — extracted as a pure function (generations + slide count → ordered `{ index, url, name }[]`) and tested, including superseded retries being excluded and a gap in slide indexes not producing a misnumbered entry.
- **`next` validation on the callback** — a relative path is accepted; an absolute URL, a protocol-relative `//evil.test`, and a missing param all fall back to `/ideas`.

No live-network or live-Supabase tests, consistent with this repo.

## 7. Out of scope

- Downloading superseded/historical generations from the Gallery's history dialog.
- Any image format conversion or resizing on download — the stored JPEG is served as-is.
- Custom SMTP configuration, and any admin-generated-link fallback (§5).
- Email confirmation on signup. The new `/auth/callback` route is what that would need, but turning it on is a separate decision.
- Rate limiting the reset request beyond whatever Supabase already applies.
