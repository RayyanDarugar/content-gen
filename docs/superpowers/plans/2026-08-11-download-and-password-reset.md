# Image Download and Password Reset (D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download generated images — one slide or a whole carousel — and reset a forgotten password.

**Architecture:** Per-image download is a pure Cloudinary URL transform (`fl_attachment`), needing no route at all. Whole-carousel download is one route that zips the published slides. Password reset is the standard Supabase flow, whose callback route this app has never had. See `docs/superpowers/specs/2026-08-11-download-and-password-reset-design.md`.

**Tech Stack:** Next.js 16.2.10 (App Router, route handlers, server actions), Supabase (auth + SSR clients), `jszip` (new), TypeScript, Vitest, Tailwind + shadcn/ui.

## Global Constraints

- **Downloads serve `publishedImageUrl(gen)`** — `composited_url || public_url` — so the file on disk carries its QR code, logo and speaker photo. Serving `public_url` directly would hand the user the clean anchor the model was fed, which looks nothing like what published. Download is a display path, and display paths go through that chokepoint.
- **`attachmentUrl` must pass through anything that is not a recognisable Cloudinary upload URL** — a data URI, another host, an empty string. Blind insertion corrupts them.
- **The zip route must be tenant-scoped:** the idea is loaded filtered by `id` **and** `user_id`.
- **The `next` param on the auth callback must be rejected unless it is a relative path beginning with `/`**, or the callback becomes an open redirect.
- **The reset response must not reveal whether an account exists** — the same confirmation either way, matching how `app/signup/actions.ts` already declines to leak registration state.
- **Next.js 16.2.10.** Per `AGENTS.md`, App Router APIs differ from your training data — read `node_modules/next/dist/docs/` before using one. Two that matter here: a route handler's `params` is a **Promise** and must be awaited, and `cookies()` is async with `.set()` legal only in a Server Function or Route Handler.
- **`"use server"` files publish every export as a POST-reachable endpoint** — every action starts with `requireUser()` where a session is required.
- Tests are Vitest (`npm run test`), pure-logic only, flat in `tests/<name>.test.ts`. No live-network or live-Supabase tests.
- Commit after every task. Conventional-commit prefixes.

## Out of scope

Downloading superseded generations from the Gallery's history dialog. Format conversion or resizing. Custom SMTP and any admin-generated-link fallback. Email confirmation on signup. Extra rate limiting on reset requests.

## File map

| File | Responsibility |
|---|---|
| `lib/download-url.ts` | **create** — `attachmentUrl`, `slugForAttachment` (pure) |
| `lib/download-zip.ts` | **create** — `zipEntriesForIdea` (pure) |
| `app/api/posts/[ideaId]/download/route.ts` | **create** — streams the carousel zip |
| `app/(app)/gallery/gallery-card.tsx` | **modify** — per-slide and whole-carousel controls |
| `app/auth/callback/route.ts` | **create** — exchange the emailed code for a session |
| `app/auth/update-password/page.tsx` | **create** — set a new password |
| `app/login/page.tsx` | **modify** — "Forgot password?" |

---

## Task 1: The attachment URL transform

**Files:**
- Create: `lib/download-url.ts`
- Test: `tests/download-url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `attachmentUrl(url: string, filename?: string): string`; `slugForAttachment(name: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/download-url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { attachmentUrl, slugForAttachment } from "@/lib/download-url";

const CLOUDINARY = "https://res.cloudinary.com/demo/image/upload/v1712345678/athena/abc123.jpg";

describe("attachmentUrl", () => {
  it("inserts fl_attachment into a Cloudinary upload URL", () => {
    expect(attachmentUrl(CLOUDINARY)).toBe(
      "https://res.cloudinary.com/demo/image/upload/fl_attachment/v1712345678/athena/abc123.jpg",
    );
  });

  it("names the file when given one", () => {
    expect(attachmentUrl(CLOUDINARY, "Why founders stall")).toBe(
      "https://res.cloudinary.com/demo/image/upload/fl_attachment:why-founders-stall/v1712345678/athena/abc123.jpg",
    );
  });

  // Cloudinary delimits transformation components with "/" and ",", so an
  // unsanitised concept would corrupt the URL rather than name the file.
  it("sanitises a filename containing delimiters", () => {
    const out = attachmentUrl(CLOUDINARY, "a/b,c d");
    expect(out).toContain("fl_attachment:a-b-c-d/");
    expect(out.split("/image/upload/")[1].split("/")[0]).toBe("fl_attachment:a-b-c-d");
  });

  // Test Run previews are data URIs; other hosts and empty values reach this
  // too. Blind insertion would corrupt all three.
  it("passes a data URI through unchanged", () => {
    const uri = "data:image/png;base64,AAAA";
    expect(attachmentUrl(uri, "x")).toBe(uri);
  });

  it("passes a non-Cloudinary URL through unchanged", () => {
    const url = "https://example.test/image/upload/v1/x.jpg";
    expect(attachmentUrl(url)).toBe(url);
  });

  it("passes an empty string through unchanged", () => {
    expect(attachmentUrl("")).toBe("");
  });

  it("leaves a raw (non-image) Cloudinary URL alone", () => {
    const raw = "https://res.cloudinary.com/demo/raw/upload/v1/brand-docs/deck.pdf";
    expect(attachmentUrl(raw)).toBe(raw);
  });
});

describe("slugForAttachment", () => {
  it("lowercases and hyphenates", () => {
    expect(slugForAttachment("Why Founders Stall")).toBe("why-founders-stall");
  });

  it("collapses runs and trims edges", () => {
    expect(slugForAttachment("  --Hello,   World!!  ")).toBe("hello-world");
  });

  it("caps the length", () => {
    expect(slugForAttachment("a".repeat(100)).length).toBe(60);
  });

  it("falls back rather than returning an empty slug", () => {
    expect(slugForAttachment("!!!")).toBe("download");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/download-url.test.ts`
Expected: FAIL — cannot resolve `@/lib/download-url`.

- [ ] **Step 3: Write the implementation**

Create `lib/download-url.ts`:

```ts
// Pure, and no "server-only": the Gallery's download controls are client
// components.
//
// Cloudinary sets Content-Disposition: attachment when fl_attachment appears
// in the delivery URL, so a download needs no route, no proxy and no
// buffering — the browser pulls straight from the CDN.

const HOST = "https://res.cloudinary.com/";
const UPLOAD_MARKER = "/image/upload/";

// Cloudinary delimits transformation components with "/" and ",", so an
// unsanitised concept string would corrupt the URL rather than name the file.
export function slugForAttachment(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "download";
}

// Anything that is not a recognisable Cloudinary IMAGE upload URL is returned
// unchanged — a data URI (Test Run previews produce these), another host, an
// empty string, or a /raw/upload document URL. Blind insertion would corrupt
// all of them, and a plain link is a working fallback.
export function attachmentUrl(url: string, filename?: string): string {
  if (!url.startsWith(HOST)) return url;
  const at = url.indexOf(UPLOAD_MARKER);
  if (at === -1) return url;

  const slug = filename ? slugForAttachment(filename) : "";
  const flag = slug ? `fl_attachment:${slug}` : "fl_attachment";
  const cut = at + UPLOAD_MARKER.length;
  return `${url.slice(0, cut)}${flag}/${url.slice(cut)}`;
}
```

Note `slice(60)` can leave a trailing hyphen, which is why the trailing-hyphen strip runs again after it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/download-url.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/download-url.ts tests/download-url.test.ts
git commit -m "feat: cloudinary attachment URL transform"
```

---

## Task 2: The carousel zip route

**Files:**
- Create: `lib/download-zip.ts`, `app/api/posts/[ideaId]/download/route.ts`
- Modify: `package.json` (add `jszip`)
- Test: `tests/download-zip.test.ts`

**Interfaces:**
- Consumes: `publishedImageUrl` (B1), `buildSlideView` (`lib/athena/slide-view.ts`), `slugForAttachment` (Task 1).
- Produces: `zipEntriesForIdea(generations: Generation[], slideCount: number): { url: string; name: string }[]`

- [ ] **Step 1: Add the dependency**

Run: `npm install jszip`
Then `npm install --save-dev @types/jszip` **only if** `jszip` does not ship its own types — check first; recent versions bundle them, and an unnecessary `@types` package that shadows bundled types causes confusing errors.

- [ ] **Step 2: Write the failing test**

Create `tests/download-zip.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { zipEntriesForIdea } from "@/lib/download-zip";
import type { Generation } from "@/lib/types";

function gen(over: Partial<Generation>): Generation {
  return {
    id: "g1", user_id: "u1", idea_id: "i1", kie_task_id: "t1",
    status: "succeeded", poll_count: 1, kie_style_url: "", full_prompt: "",
    refinement_notes: "", image_path: "p", public_url: "https://c/clean.jpg",
    composited_url: "", error: "", slide_index: 0, anchor_generation_id: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("zipEntriesForIdea", () => {
  it("names entries by carousel position, zero-padded so they sort", () => {
    const out = zipEntriesForIdea(
      [gen({ id: "a", slide_index: 0 }), gen({ id: "b", slide_index: 1 })],
      2,
    );
    expect(out.map((e) => e.name)).toEqual(["01.jpg", "02.jpg"]);
  });

  // The published image, not the clean anchor — this is what the user expects
  // to receive, with the QR code and speaker on it.
  it("uses the composited image when one exists", () => {
    const out = zipEntriesForIdea(
      [gen({ slide_index: 0, composited_url: "https://c/final.jpg" })],
      1,
    );
    expect(out[0].url).toBe("https://c/final.jpg");
  });

  it("falls back to the clean image when nothing was composited", () => {
    const out = zipEntriesForIdea([gen({ slide_index: 0, composited_url: "" })], 1);
    expect(out[0].url).toBe("https://c/clean.jpg");
  });

  it("skips a slide that has not succeeded", () => {
    const out = zipEntriesForIdea(
      [gen({ id: "a", slide_index: 0 }), gen({ id: "b", slide_index: 1, status: "failed" })],
      2,
    );
    expect(out.map((e) => e.name)).toEqual(["01.jpg"]);
  });

  // A gap must not renumber what follows it: slide 3 stays "03.jpg" even when
  // slide 2 is missing, or the zip silently misrepresents the carousel's order.
  it("keeps carousel positions when a slide is missing", () => {
    const out = zipEntriesForIdea(
      [gen({ id: "a", slide_index: 0 }), gen({ id: "c", slide_index: 2 })],
      3,
    );
    expect(out.map((e) => e.name)).toEqual(["01.jpg", "03.jpg"]);
  });

  it("returns nothing when no slide succeeded", () => {
    expect(zipEntriesForIdea([gen({ status: "failed" })], 1)).toEqual([]);
  });

  it("handles an idea with no generations at all", () => {
    expect(zipEntriesForIdea([], 3)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/download-zip.test.ts`
Expected: FAIL — cannot resolve `@/lib/download-zip`.

- [ ] **Step 4: Write the pure selector**

Create `lib/download-zip.ts`:

```ts
import { buildSlideView } from "@/lib/athena/slide-view";
import { publishedImageUrl } from "@/lib/athena/published-image";
import type { Generation } from "@/lib/types";

export interface ZipEntry {
  url: string;
  name: string;
}

// Pure — the route's fetching and zipping sit around this, so the selection
// and naming rules are testable without network or a zip library.
//
// buildSlideView is reused so the zip contains exactly the slides the Gallery
// shows as current, never a superseded retry.
export function zipEntriesForIdea(
  generations: Generation[],
  slideCount: number,
): ZipEntry[] {
  const { slides } = buildSlideView(generations, slideCount);
  const entries: ZipEntry[] = [];

  for (const slot of slides) {
    const gen = slot.generation;
    if (!gen || gen.status !== "succeeded") continue;
    const url = publishedImageUrl(gen);
    if (!url) continue;
    // Named by CAROUSEL POSITION, not array index: a missing slide must not
    // renumber the ones after it, or slide 3 arrives as "02.jpg" and the zip
    // misrepresents the post's order.
    entries.push({ url, name: `${String(slot.slide_index + 1).padStart(2, "0")}.jpg` });
  }

  return entries;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/download-zip.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write the route**

**Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` first** — in Next 16 a route handler's `params` is a Promise and must be awaited.

Create `app/api/posts/[ideaId]/download/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import JSZip from "jszip";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { zipEntriesForIdea } from "@/lib/download-zip";
import { slugForAttachment } from "@/lib/download-url";
import type { Generation, Idea } from "@/lib/types";

// Fetching and zipping several full-size images.
export const maxDuration = 120;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ideaId: string }> },
) {
  const { ideaId } = await params;

  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = await createServerSupabase();
  // Filtered by id AND user_id — never id alone.
  const { data } = await supabase
    .from("ideas").select("*, generations(*)")
    .eq("id", ideaId).eq("user_id", user.id).maybeSingle();
  if (!data) return NextResponse.json({ error: "unknown idea" }, { status: 404 });

  const idea = data as Idea & { generations: Generation[] };
  const slideCount = (idea.slides ?? []).length || 1;
  const entries = zipEntriesForIdea(idea.generations ?? [], slideCount);
  if (entries.length === 0) {
    return NextResponse.json({ error: "this post has no finished images" }, { status: 404 });
  }

  const zip = new JSZip();
  let added = 0;
  for (const entry of entries) {
    try {
      const res = await fetch(entry.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      zip.file(entry.name, await res.arrayBuffer());
      added++;
    } catch (e) {
      // A partial download beats a 500 when four of five images are fine.
      console.error(`zip: skipping ${entry.name} for idea ${ideaId}:`, e);
    }
  }

  // An empty zip would look like success. Fail loudly instead.
  if (added === 0) {
    return NextResponse.json({ error: "could not fetch any images" }, { status: 502 });
  }

  const body = await zip.generateAsync({ type: "nodebuffer" });
  const filename = `${slugForAttachment(idea.concept)}.zip`;
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/download-zip.ts tests/download-zip.test.ts "app/api/posts/[ideaId]/download/route.ts" package.json package-lock.json
git commit -m "feat: download a whole carousel as a zip"
```

---

## Task 3: Download controls in the Gallery

**Files:**
- Modify: `app/(app)/gallery/gallery-card.tsx`

**Interfaces:**
- Consumes: `attachmentUrl`, `slugForAttachment` (Task 1); the route from Task 2; `publishedImageUrl` (B1).
- Produces: nothing new.

- [ ] **Step 1: Add the controls**

`gallery-card.tsx` already computes `current` (the displayed generation), `isCarousel`, and `allSucceeded`, and renders a row of controls in its `CardContent`. Add to that row, alongside the existing Regenerate/history controls:

```tsx
{current?.status === "succeeded" && publishedImageUrl(current) && (
  <a
    href={attachmentUrl(publishedImageUrl(current), idea.concept)}
    download
    className="text-xs underline text-muted-foreground"
  >
    Download{isCarousel ? ` slide ${active + 1}` : ""}
  </a>
)}
{isCarousel && allSucceeded && (
  <a
    href={`/api/posts/${idea.id}/download`}
    className="text-xs underline text-muted-foreground"
  >
    Download all {slideCount}
  </a>
)}
```

Import `attachmentUrl` from `@/lib/download-url` and `publishedImageUrl` from `@/lib/athena/published-image`.

The per-slide link needs no route: `fl_attachment` makes Cloudinary send `Content-Disposition: attachment`, so the browser saves rather than navigates. The `download` attribute is belt-and-braces and does nothing cross-origin on its own.

The zip link deliberately has **no** `download` attribute — the route sets `Content-Disposition` itself, and the attribute is ignored cross-origin anyway.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS. Do not start a long-running dev server; report what you could not verify without a browser.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/gallery/gallery-card.tsx"
git commit -m "feat: download controls in the gallery"
```

---

## Task 4: Password reset

**Files:**
- Create: `app/auth/callback/route.ts`, `app/auth/update-password/page.tsx`
- Modify: `app/login/page.tsx`
- Test: `tests/safe-next.test.ts`

**Interfaces:**
- Consumes: `createServerSupabase`, `createBrowserSupabase`, `requireUser`.
- Produces: `safeNextPath(next: string | null): string`

None of this exists today: `app/auth/` contains only `signout`.

- [ ] **Step 1: Write the failing test**

Create `tests/safe-next.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/safe-next";

describe("safeNextPath", () => {
  it("accepts a relative path", () => {
    expect(safeNextPath("/auth/update-password")).toBe("/auth/update-password");
  });

  it("falls back when the param is missing", () => {
    expect(safeNextPath(null)).toBe("/ideas");
  });

  // The callback runs with a freshly minted session, so an open redirect here
  // hands an attacker an authenticated user on their own domain.
  it("rejects an absolute URL", () => {
    expect(safeNextPath("https://evil.test/steal")).toBe("/ideas");
  });

  it("rejects a protocol-relative URL", () => {
    expect(safeNextPath("//evil.test/steal")).toBe("/ideas");
  });

  it("rejects a path that does not start with a slash", () => {
    expect(safeNextPath("ideas")).toBe("/ideas");
  });

  it("rejects an empty string", () => {
    expect(safeNextPath("")).toBe("/ideas");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/safe-next.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth/safe-next`.

- [ ] **Step 3: Write the guard**

Create `lib/auth/safe-next.ts` (pure — no `server-only`, so the test can import it):

```ts
// The callback redirects to `next` while holding a freshly minted session, so
// an open redirect here would hand an attacker an authenticated user on their
// own domain. Only same-origin relative paths are allowed: "//evil.test" is a
// protocol-relative URL, not a path, which is why one leading slash is not
// enough on its own.
export function safeNextPath(next: string | null): string {
  if (!next) return "/ideas";
  if (!next.startsWith("/")) return "/ideas";
  if (next.startsWith("//")) return "/ideas";
  return next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/safe-next.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the callback route**

**Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` and the `cookies` doc first.** Model this on `app/auth/signout/route.ts`, which is the only existing auth route.

Create `app/auth/callback/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/auth/safe-next";

// This app has never had a callback route. It is what a password-reset link
// needs, and also what email confirmation on signup would need if that is ever
// turned on.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));

  if (code) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, request.nextUrl.origin));
  }

  return NextResponse.redirect(new URL("/login?error=link", request.nextUrl.origin));
}
```

- [ ] **Step 6: Write the update-password page**

Create `app/auth/update-password/page.tsx`. It must be behind `requireUser()` — the recovery session created by the callback is what authorises the change, and without the guard the page is reachable unauthenticated.

```tsx
import { requireUser } from "@/lib/auth/require-user";
import { UpdatePasswordForm } from "./form";

export default async function UpdatePasswordPage() {
  // The recovery session minted by /auth/callback is what authorises this.
  await requireUser();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <UpdatePasswordForm />
    </main>
  );
}
```

and `app/auth/update-password/form.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function UpdatePasswordForm() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    // Matches the minimum app/signup/actions.ts already enforces.
    if (password.length < 8) {
      setErr("Use at least 8 characters.");
      return;
    }
    setBusy(true);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    router.push("/ideas");
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-base">Choose a new password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <Input
            type="password" placeholder="New password" value={password}
            onChange={(e) => setPassword(e.target.value)} required
          />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Saving…" : "Save password"}
          </Button>
          {err && <p className="text-sm text-destructive">{err}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 7: Add "Forgot password?" to the login page**

`app/login/page.tsx` currently renders a single `LoginForm` card. Add a `mode` state that toggles it between signing in and requesting a reset, keeping one card rather than adding a second page.

Inside `LoginForm`, add:

```tsx
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [notice, setNotice] = useState("");

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const supabase = createBrowserSupabase();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/update-password`,
    });
    // Deliberately the same message whether or not that email has an account,
    // and the call's error is not surfaced — revealing which addresses are
    // registered is exactly what app/signup/actions.ts declines to do too.
    setNotice("If that email has an account, a reset link is on its way.");
  }
```

and render the reset variant when `mode === "reset"` — the same email `Input`, a "Send reset link" button wired to `requestReset`, the `notice` paragraph, and a link back to signing in. In signin mode, add beneath the existing "No account?" line:

```tsx
<button
  type="button"
  className="mt-1 text-sm underline text-muted-foreground"
  onClick={() => { setMode("reset"); setErr(""); setNotice(""); }}
>
  Forgot password?
</button>
```

Finally, surface the callback's failure case. `LoginPage` is a server component, so read it there and pass it down:

```tsx
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <LoginForm linkFailed={error === "link"} />
    </main>
  );
}
```

with `LoginForm` taking `{ linkFailed = false }: { linkFailed?: boolean }` and rendering, when true: *"That link didn't work — it may have expired. Request a new one."*

**Confirm `searchParams` is a Promise in this Next version** by reading `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md` before writing it.

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS. Do not start a dev server.

- [ ] **Step 9: Report the config item**

The `redirectTo` URL must be in the Supabase project's allowed redirect list or the link bounces. That is a dashboard setting, not code. State it plainly in your report so the repo owner knows to add both the local and production origins.

- [ ] **Step 10: Commit**

```bash
git add lib/auth/safe-next.ts tests/safe-next.test.ts app/auth/callback/route.ts app/auth/update-password app/login/page.tsx
git commit -m "feat: password reset flow"
```
