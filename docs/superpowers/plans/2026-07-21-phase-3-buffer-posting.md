# Phase 3 — Buffer Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post curated carousels of generated images to TikTok via Buffer's GraphQL API from a new `/post` page.

**Architecture:** Pure carousel logic (caption pick, auto-fill selection, mutation building, token routing) lives in `lib/athena/carousel.ts` with vitest coverage; a thin HTTP wrapper `lib/athena/buffer.ts` calls `api.buffer.com`; `POST /api/posts/create` validates and orchestrates; `/post` is a server page + client composer following the gallery's pattern. Images are already public Cloudinary URLs on `generations.public_url` — no upload step.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres via service-role client), shadcn/ui, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-21-phase-3-buffer-posting-design.md` — it governs on any conflict.
- Buffer mutation is the n8n Workflow C port: `schedulingType: automatic`, `mode: addToQueue`, `assets: [{ image: { url: "..." } }]`; response success = `data.createPost.post.id` present; error message at `data.createPost.message`.
- Caption is passed as a GraphQL **variable** (`$text: String!`) — never string-interpolated into the query.
- Partial sets blocked: a post requires exactly `categories.images_per_carousel` images, server-enforced.
- Postable generation = newest **succeeded** generation of an idea whose `status = 'generated'`, matching the requested category.
- On Buffer failure: insert `posts` row `status:'failed'` with response body in `error`; ideas untouched. On success: insert `posts` (`queued`) + `post_images` (request order) then flip ideas to `posted`.
- Auth on user-facing route via `requireAllowedUser()` from `@/lib/auth/require-user`; DB writes via `createAdminSupabase()` from `@/lib/supabase/admin`.
- Env: `BUFFER_TOKEN_1` / `BUFFER_TOKEN_2` (already in `.env.local`), selected by `categories.buffer_account` (1 | 2).
- This project is deployed by pushing `main` (Vercel auto-deploy). Read `node_modules/next/dist/docs/` guidance before writing Next.js code (per AGENTS.md).

## File Structure

- `supabase/migrations/0004_posts_error.sql` — add `error` column to posts (create)
- `lib/types.ts` — add `Post` type (modify)
- `lib/athena/carousel.ts` — pure logic (create); `tests/carousel.test.ts` (create)
- `lib/athena/buffer.ts` — Buffer HTTP client (create)
- `app/api/posts/create/route.ts` — orchestration route (create)
- `app/(app)/post/page.tsx` — server page (create); `app/(app)/post/post-composer.tsx` — client composer (create)
- `app/(app)/layout.tsx` — nav entry (modify)

---

### Task 1: Migration, types, and Buffer auth-header verification

**Files:**
- Create: `supabase/migrations/0004_posts_error.sql`
- Modify: `lib/types.ts` (append at end)

**Interfaces:**
- Produces: `Post` type in `@/lib/types`; verified knowledge of Buffer's auth header (recorded as a comment in the migration commit message and used by Task 3).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0004_posts_error.sql
-- Phase 3: record Buffer failure detail on posts.
alter table posts add column error text not null default '';
```

- [ ] **Step 2: Append the Post type to `lib/types.ts`**

```ts
export interface Post {
  id: string;
  category_key: string;
  buffer_update_id: string;
  caption: string;
  status: "created" | "queued" | "failed";
  error: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Verify Buffer's auth header with one cheap curl**

The n8n export hid the header name inside a stored credential. Run (token comes from `.env.local` `BUFFER_TOKEN_1`):

```bash
cd "/Users/rayyandarugar/Coding Projects/content-gen-app"
TOKEN=$(grep '^BUFFER_TOKEN_1=' .env.local | cut -d= -f2)
curl -s -X POST https://api.buffer.com \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"query":"query { __typename }"}'
```

Expected: JSON containing `"__typename"` (any GraphQL-shaped response, not an auth error). If it returns an auth/401-style error, retry once with `-H "Authorization: $TOKEN"` (no Bearer). Record which form worked — Task 3's `postToBuffer` must use it. If NEITHER works, STOP and report BLOCKED with both response bodies.

- [ ] **Step 4: Verify build passes**

Run: `npm run build`
Expected: success, no type errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_posts_error.sql lib/types.ts
git commit -m "feat: posts.error column + Post type; verified Buffer auth header (<record which form worked here>)"
```

Note: applying the migration to live Supabase is a user step in Task 5 — do not attempt it.

---

### Task 2: Carousel pure logic (TDD)

**Files:**
- Create: `lib/athena/carousel.ts`
- Test: `tests/carousel.test.ts`

**Interfaces:**
- Produces (Tasks 3–4 rely on these exact signatures):
  - `interface Postable { generation_id: string; idea_id: string; idea_created_at: string; public_url: string; concept: string }`
  - `pickCaption(raw: string, rand?: () => number): string`
  - `selectAutoFill(postables: Postable[], n: number): Postable[]`
  - `buildCreatePostMutation(channelId: string, imageUrls: string[], caption: string): { query: string; variables: { text: string } }`
  - `bufferTokenFor(account: 1 | 2): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/carousel.test.ts
import { describe, expect, it, afterEach } from "vitest";
import {
  pickCaption, selectAutoFill, buildCreatePostMutation, bufferTokenFor,
  type Postable,
} from "@/lib/athena/carousel";

function postable(overrides: Partial<Postable>): Postable {
  return {
    generation_id: "g1", idea_id: "i1", idea_created_at: "2026-07-01T00:00:00Z",
    public_url: "https://res.cloudinary.com/x/a.jpg", concept: "c",
    ...overrides,
  };
}

describe("pickCaption", () => {
  it("picks a variant deterministically via injected rand", () => {
    expect(pickCaption("a || b || c", () => 0)).toBe("a");
    expect(pickCaption("a || b || c", () => 0.99)).toBe("c");
  });
  it("trims variants and drops empties", () => {
    expect(pickCaption("  hello  ||  || ", () => 0)).toBe("hello");
  });
  it("returns empty string for empty/whitespace input", () => {
    expect(pickCaption("", () => 0)).toBe("");
    expect(pickCaption("  ||  ", () => 0)).toBe("");
  });
});

describe("selectAutoFill", () => {
  it("returns oldest n by idea_created_at", () => {
    const items = [
      postable({ generation_id: "g3", idea_created_at: "2026-07-03T00:00:00Z" }),
      postable({ generation_id: "g1", idea_created_at: "2026-07-01T00:00:00Z" }),
      postable({ generation_id: "g2", idea_created_at: "2026-07-02T00:00:00Z" }),
    ];
    expect(selectAutoFill(items, 2).map((p) => p.generation_id)).toEqual(["g1", "g2"]);
  });
  it("returns fewer than n when not enough", () => {
    expect(selectAutoFill([postable({})], 5)).toHaveLength(1);
  });
  it("does not mutate its input", () => {
    const items = [
      postable({ generation_id: "g2", idea_created_at: "2026-07-02T00:00:00Z" }),
      postable({ generation_id: "g1", idea_created_at: "2026-07-01T00:00:00Z" }),
    ];
    selectAutoFill(items, 2);
    expect(items[0].generation_id).toBe("g2");
  });
});

describe("buildCreatePostMutation", () => {
  it("builds the Workflow C mutation with caption as a variable", () => {
    const { query, variables } = buildCreatePostMutation(
      "chan1", ["https://a/1.jpg", "https://a/2.jpg"], 'my "caption"\nline2',
    );
    expect(variables).toEqual({ text: 'my "caption"\nline2' });
    expect(query).toContain("mutation CreatePost($text: String!)");
    expect(query).toContain("text: $text");
    expect(query).toContain('channelId: "chan1"');
    expect(query).toContain("schedulingType: automatic");
    expect(query).toContain("mode: addToQueue");
    expect(query).toContain('{ image: { url: "https://a/1.jpg" } }');
    expect(query).toContain('{ image: { url: "https://a/2.jpg" } }');
    expect(query).toContain("PostActionSuccess");
    expect(query).toContain("MutationError");
    // caption must never be interpolated into the query body
    expect(query).not.toContain("my ");
  });
});

describe("bufferTokenFor", () => {
  afterEach(() => {
    delete process.env.BUFFER_TOKEN_1;
    delete process.env.BUFFER_TOKEN_2;
  });
  it("routes account to the matching env token", () => {
    process.env.BUFFER_TOKEN_1 = "t1";
    process.env.BUFFER_TOKEN_2 = "t2";
    expect(bufferTokenFor(1)).toBe("t1");
    expect(bufferTokenFor(2)).toBe("t2");
  });
  it("throws when the token is unset", () => {
    expect(() => bufferTokenFor(1)).toThrow(/BUFFER_TOKEN_1/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/carousel.test.ts`
Expected: FAIL — cannot resolve `@/lib/athena/carousel`.

- [ ] **Step 3: Implement `lib/athena/carousel.ts`**

```ts
export interface Postable {
  generation_id: string;
  idea_id: string;
  idea_created_at: string;
  public_url: string;
  concept: string;
}

export function pickCaption(raw: string, rand: () => number = Math.random): string {
  const variants = raw.split("||").map((s) => s.trim()).filter(Boolean);
  if (variants.length === 0) return "";
  return variants[Math.floor(rand() * variants.length)];
}

export function selectAutoFill(postables: Postable[], n: number): Postable[] {
  return [...postables]
    .sort((a, b) => a.idea_created_at.localeCompare(b.idea_created_at))
    .slice(0, n);
}

// Port of n8n Workflow C "Group Into Carousels". channelId and image URLs are
// app-controlled values; the caption is user text and travels as a variable.
export function buildCreatePostMutation(
  channelId: string,
  imageUrls: string[],
  caption: string,
): { query: string; variables: { text: string } } {
  const assetsBlock = imageUrls
    .map((url) => `{ image: { url: "${url}" } }`)
    .join("\n        ");
  const query = `mutation CreatePost($text: String!) {
  createPost(
    input: {
      text: $text
      channelId: "${channelId}"
      schedulingType: automatic
      mode: addToQueue
      assets: [
        ${assetsBlock}
      ]
    }
  ) {
    ... on PostActionSuccess {
      post { id }
    }
    ... on MutationError {
      message
    }
  }
}`;
  return { query, variables: { text: caption } };
}

export function bufferTokenFor(account: 1 | 2): string {
  const name = account === 1 ? "BUFFER_TOKEN_1" : "BUFFER_TOKEN_2";
  const token = process.env[name];
  if (!token) throw new Error(`${name} is not set`);
  return token;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/carousel.test.ts`
Expected: all PASS. Then `npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/athena/carousel.ts tests/carousel.test.ts
git commit -m "feat: carousel logic - caption pick, auto-fill, Buffer mutation, token routing"
```

---

### Task 3: Buffer client + `POST /api/posts/create`

**Files:**
- Create: `lib/athena/buffer.ts`
- Create: `app/api/posts/create/route.ts`

**Interfaces:**
- Consumes: `buildCreatePostMutation`, `bufferTokenFor` from `@/lib/athena/carousel` (Task 2); `Post` type exists (Task 1). **Check Task 1's commit message for the verified auth header form and use it.**
- Produces: `POST /api/posts/create` accepting `{ category_key: string, generation_ids: string[], caption: string }`, returning `{ post_id, buffer_update_id }` (200) or `{ error }` (400/401/500). Task 4's composer calls it.

- [ ] **Step 1: Implement `lib/athena/buffer.ts`**

```ts
import "server-only";
import { buildCreatePostMutation, bufferTokenFor } from "./carousel";

export interface BufferResult {
  success: boolean;
  postId: string;
  error: string;
  rawBody: string;
}

export async function postToBuffer(
  account: 1 | 2,
  channelId: string,
  imageUrls: string[],
  caption: string,
): Promise<BufferResult> {
  const token = bufferTokenFor(account);
  const body = buildCreatePostMutation(channelId, imageUrls, caption);
  const res = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      // Use the header form verified in Task 1 (default: Bearer).
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const rawBody = await res.text();
  let postId = "";
  let error = "";
  try {
    const json = JSON.parse(rawBody);
    postId = json?.data?.createPost?.post?.id ?? "";
    error = json?.data?.createPost?.message ?? "";
    if (!postId && !error && json?.errors) {
      error = JSON.stringify(json.errors);
    }
  } catch {
    error = `non-JSON response (HTTP ${res.status})`;
  }
  if (!postId && !error) error = `no post id in response (HTTP ${res.status})`;
  return { success: !!postId, postId, error, rawBody };
}
```

- [ ] **Step 2: Implement `app/api/posts/create/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { requireAllowedUser } from "@/lib/auth/require-user";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { postToBuffer } from "@/lib/athena/buffer";
import type { Category, Generation, Idea } from "@/lib/types";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    await requireAllowedUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryKey: unknown = body?.category_key;
  const generationIds: unknown = body?.generation_ids;
  const caption: unknown = body?.caption;
  if (
    typeof categoryKey !== "string" ||
    !Array.isArray(generationIds) ||
    !generationIds.every((id) => typeof id === "string") ||
    typeof caption !== "string"
  ) {
    return NextResponse.json(
      { error: "expected { category_key, generation_ids: string[], caption }" },
      { status: 400 },
    );
  }

  const supabase = createAdminSupabase();

  const { data: category, error: catErr } = await supabase
    .from("categories").select("*").eq("key", categoryKey).single();
  if (catErr || !category || !(category as Category).active) {
    return NextResponse.json({ error: "unknown or inactive category" }, { status: 400 });
  }
  const cat = category as Category;

  if (generationIds.length !== cat.images_per_carousel) {
    return NextResponse.json(
      { error: `need exactly ${cat.images_per_carousel} images, got ${generationIds.length}` },
      { status: 400 },
    );
  }

  const { data: gensData, error: genErr } = await supabase
    .from("generations")
    .select("*, idea:ideas(*)")
    .in("id", generationIds as string[]);
  if (genErr) return NextResponse.json({ error: genErr.message }, { status: 500 });
  const gens = (gensData ?? []) as (Generation & { idea: Idea })[];
  if (gens.length !== generationIds.length) {
    return NextResponse.json({ error: "one or more generations not found" }, { status: 400 });
  }

  const ideaIds = gens.map((g) => g.idea_id);
  if (new Set(ideaIds).size !== ideaIds.length) {
    return NextResponse.json({ error: "duplicate ideas in selection" }, { status: 400 });
  }
  for (const g of gens) {
    if (g.status !== "succeeded" || !g.public_url) {
      return NextResponse.json({ error: `generation ${g.id} has no successful image` }, { status: 400 });
    }
    if (g.idea.status !== "generated") {
      return NextResponse.json({ error: `idea for generation ${g.id} is not postable (${g.idea.status})` }, { status: 400 });
    }
    if (g.idea.category_key !== categoryKey) {
      return NextResponse.json({ error: `generation ${g.id} belongs to another category` }, { status: 400 });
    }
  }

  // Each selected generation must be the newest succeeded one for its idea.
  const { data: siblingsData, error: sibErr } = await supabase
    .from("generations")
    .select("id, idea_id, status, created_at")
    .in("idea_id", ideaIds);
  if (sibErr) return NextResponse.json({ error: sibErr.message }, { status: 500 });
  const newestByIdea = new Map<string, string>();
  for (const s of (siblingsData ?? []) as Pick<Generation, "id" | "idea_id" | "status" | "created_at">[]) {
    if (s.status !== "succeeded") continue;
    const cur = newestByIdea.get(s.idea_id);
    if (!cur) { newestByIdea.set(s.idea_id, s.id); continue; }
    const curCreated = (siblingsData as { id: string; created_at: string }[])
      .find((x) => x.id === cur)!.created_at;
    if (s.created_at > curCreated) newestByIdea.set(s.idea_id, s.id);
  }
  for (const g of gens) {
    if (newestByIdea.get(g.idea_id) !== g.id) {
      return NextResponse.json(
        { error: `generation ${g.id} is superseded by a newer image for its idea` },
        { status: 400 },
      );
    }
  }

  // Preserve the request's carousel order.
  const byId = new Map(gens.map((g) => [g.id, g]));
  const ordered = (generationIds as string[]).map((id) => byId.get(id)!);
  const imageUrls = ordered.map((g) => g.public_url);

  let result;
  try {
    result = await postToBuffer(cat.buffer_account, cat.buffer_channel_id, imageUrls, caption);
  } catch (e) {
    result = { success: false, postId: "", error: e instanceof Error ? e.message : String(e), rawBody: "" };
  }

  if (!result.success) {
    await supabase.from("posts").insert({
      category_key: categoryKey,
      caption,
      status: "failed",
      error: result.error || result.rawBody.slice(0, 2000),
    });
    console.error("buffer post failed:", result.error, result.rawBody.slice(0, 500));
    return NextResponse.json({ error: `Buffer post failed: ${result.error}` }, { status: 500 });
  }

  const { data: postRow, error: postErr } = await supabase
    .from("posts")
    .insert({
      category_key: categoryKey,
      buffer_update_id: result.postId,
      caption,
      status: "queued",
    })
    .select()
    .single();
  if (postErr || !postRow) {
    return NextResponse.json(
      { error: `posted to Buffer (${result.postId}) but failed to record post: ${postErr?.message}` },
      { status: 500 },
    );
  }
  await supabase.from("post_images").insert(
    ordered.map((g, idx) => ({ post_id: postRow.id, generation_id: g.id, sort_order: idx })),
  );
  const { error: ideaErr } = await supabase
    .from("ideas").update({ status: "posted" }).in("id", ideaIds);
  if (ideaErr) {
    return NextResponse.json(
      { error: `posted (${result.postId}) but failed to mark ideas: ${ideaErr.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ post_id: postRow.id, buffer_update_id: result.postId });
}
```

- [ ] **Step 3: Verify build and full test suite**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/athena/buffer.ts app/api/posts/create/route.ts
git commit -m "feat: Buffer client and /api/posts/create route"
```

---

### Task 4: `/post` page UI + nav

**Files:**
- Create: `app/(app)/post/page.tsx`
- Create: `app/(app)/post/post-composer.tsx`
- Modify: `app/(app)/layout.tsx` (nav array — add Post entry after Gallery)

**Interfaces:**
- Consumes: `POST /api/posts/create` (Task 3 contract), `pickCaption`, `selectAutoFill`, `Postable` from `@/lib/athena/carousel`, `Category`, `Post` from `@/lib/types`.
- Produces: user-facing posting flow; nothing downstream.

- [ ] **Step 1: Add nav entry in `app/(app)/layout.tsx`**

Find the nav array containing `{ href: "/gallery", label: "Gallery" }` and add after it:

```ts
  { href: "/post", label: "Post" },
```

- [ ] **Step 2: Implement `app/(app)/post/page.tsx` (server component)**

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { PostComposer } from "./post-composer";
import type { Postable } from "@/lib/athena/carousel";
import type { Category, Generation, Idea, Post } from "@/lib/types";

type IdeaWithGenerations = Idea & { generations: Generation[] };

export default async function PostPage() {
  const supabase = await createServerSupabase();
  const [{ data: catData }, { data: ideaData }, { data: postData }] = await Promise.all([
    supabase.from("categories").select("*").eq("active", true).order("key"),
    supabase
      .from("ideas")
      .select("*, generations(*)")
      .eq("status", "generated")
      .order("created_at", { ascending: true }),
    supabase.from("posts").select("*").order("created_at", { ascending: false }).limit(50),
  ]);
  const categories = (catData ?? []) as Category[];
  const ideas = (ideaData ?? []) as IdeaWithGenerations[];
  const posts = (postData ?? []) as Post[];

  // Postable = newest succeeded generation per generated idea.
  const postablesByCategory = new Map<string, Postable[]>();
  for (const idea of ideas) {
    const newest = idea.generations
      .filter((g) => g.status === "succeeded" && g.public_url)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!newest) continue;
    const list = postablesByCategory.get(idea.category_key) ?? [];
    list.push({
      generation_id: newest.id,
      idea_id: idea.id,
      idea_created_at: idea.created_at,
      public_url: newest.public_url,
      concept: idea.concept,
    });
    postablesByCategory.set(idea.category_key, list);
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Post</h1>
      <div className="space-y-6">
        {categories.map((cat) => (
          <PostComposer
            key={cat.key}
            category={cat}
            postables={postablesByCategory.get(cat.key) ?? []}
          />
        ))}
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">History</h2>
        {posts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No posts yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Category</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Buffer ID</th>
                  <th className="py-2">Caption / Error</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id} className="border-b align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {new Date(p.created_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">{p.category_key}</td>
                    <td className="py-2 pr-4">
                      {p.status === "failed" ? (
                        <span className="text-red-500">failed</span>
                      ) : p.status}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{p.buffer_update_id || "—"}</td>
                    <td className="py-2 max-w-md truncate" title={p.error || p.caption}>
                      {p.status === "failed" ? p.error : p.caption}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Implement `app/(app)/post/post-composer.tsx` (client component)**

```tsx
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { pickCaption, selectAutoFill, type Postable } from "@/lib/athena/carousel";
import type { Category } from "@/lib/types";

export function PostComposer({
  category,
  postables,
}: {
  category: Category;
  postables: Postable[];
}) {
  const router = useRouter();
  const n = category.images_per_carousel;
  const initial = useMemo(() => selectAutoFill(postables, n), [postables, n]);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    initial.map((p) => p.generation_id),
  );
  const [caption, setCaption] = useState(() => pickCaption(category.post_caption));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const byId = useMemo(
    () => new Map(postables.map((p) => [p.generation_id, p])),
    [postables],
  );
  const selected = selectedIds.map((id) => byId.get(id)!).filter(Boolean);
  const pool = postables.filter((p) => !selectedIds.includes(p.generation_id));
  const ready = postables.length >= n;

  function remove(id: string) {
    setSelectedIds((ids) => ids.filter((x) => x !== id));
  }
  function add(id: string) {
    setSelectedIds((ids) => (ids.length < n ? [...ids, id] : ids));
  }
  function move(idx: number, dir: -1 | 1) {
    setSelectedIds((ids) => {
      const j = idx + dir;
      if (j < 0 || j >= ids.length) return ids;
      const next = [...ids];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  async function post() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/posts/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category_key: category.key,
          generation_ids: selectedIds,
          caption,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMessage({ ok: true, text: `Queued in Buffer (${json.buffer_update_id})` });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{category.name}</h2>
        <span className="text-sm text-muted-foreground">
          {Math.min(postables.length, n)} of {n} ready
        </span>
      </div>

      {!ready ? (
        <p className="text-sm text-muted-foreground">
          Not enough postable images yet ({postables.length} of {n}).
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            {selected.map((p, idx) => (
              <div key={p.generation_id} className="relative w-28 space-y-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.public_url}
                  alt={p.concept.slice(0, 60)}
                  className="h-28 w-28 cursor-pointer rounded border object-cover"
                  onClick={() => remove(p.generation_id)}
                  title="Click to remove"
                />
                <div className="flex items-center justify-between text-xs">
                  <button onClick={() => move(idx, -1)} disabled={idx === 0}>◀</button>
                  <span>{idx + 1}</span>
                  <button onClick={() => move(idx, 1)} disabled={idx === selected.length - 1}>▶</button>
                </div>
              </div>
            ))}
          </div>

          {pool.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Swap in (click to add{selectedIds.length >= n ? " — remove one first" : ""}):
              </p>
              <div className="flex flex-wrap gap-2">
                {pool.map((p) => (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={p.generation_id}
                    src={p.public_url}
                    alt={p.concept.slice(0, 60)}
                    className="h-16 w-16 cursor-pointer rounded border object-cover opacity-70 hover:opacity-100"
                    onClick={() => add(p.generation_id)}
                  />
                ))}
              </div>
            </div>
          )}

          <Textarea
            rows={2}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Caption"
          />
          <div className="flex items-center gap-3">
            <Button onClick={post} disabled={busy || selectedIds.length !== n}>
              {busy ? "Posting…" : `Post ${n === 1 ? "image" : "carousel"} to Buffer`}
            </Button>
            {message && (
              <span className={`text-sm ${message.ok ? "text-green-600" : "text-red-500"}`}>
                {message.text}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
```

Note: `pickCaption` and `selectAutoFill` are pure functions imported into a client component — `lib/athena/carousel.ts` must NOT import `server-only` (it doesn't, per Task 2).

- [ ] **Step 4: Verify build and full test suite**

Run: `npm run build && npm test`
Expected: build succeeds (all routes listed incl. `/post`), tests pass.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/post" "app/(app)/layout.tsx"
git commit -m "feat: /post page - carousel composer with auto-fill, caption, history"
```

---

### Task 5: Deploy + production acceptance (user-assisted)

**Files:** none (operational task — run by the session controller, not a subagent)

- [ ] **Step 1: Push to deploy**

```bash
git push origin main
```

- [ ] **Step 2: User steps (present as a short checklist and wait)**

1. Run migration 0004 in the Supabase SQL editor: `alter table posts add column error text not null default '';`
2. Add `BUFFER_TOKEN_1` and `BUFFER_TOKEN_2` to Vercel env vars (Production) if not already there, then redeploy if Vercel prompts.

- [ ] **Step 3: Acceptance test (user, in production)**

1. Open `/post` — categories show correct "x of N ready" counts.
2. For one category with a full set: adjust selection/caption if desired, hit Post.
3. Verify: success message with Buffer id; post visible in Buffer dashboard queue; History row `queued`; posted ideas leave the pool; gallery/ideas reflect `posted`.

- [ ] **Step 4: Retirement**

After acceptance passes, user deactivates the three n8n workflows. Phase 3 complete.
