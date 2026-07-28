# Buffer Connections Implementation Plan (Post Menu, Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** N named Buffer connections per user (same personal-key model), categories bound to connection+channel, a connection-aware token boundary, and `posts` grouping/channel columns — unblocking the three legacy categories whose channels belong to a second Buffer login.

**Architecture:** A `buffer_connections` table (in-SQL backfilled from today's single `user_settings.buffer_token_enc`) becomes the home of tokens; `lib/settings/buffer.ts` reworks around `getBufferTokenForConnection`; the Config UI grows a connections list and a channel dropdown grouped by connection; the posting route resolves the category's connection. Old `user_settings.buffer_token_enc` stays on disk unread (rollback safety).

**Tech Stack:** Next.js App Router (nonstandard — see constraints), Supabase (admin client + explicit `user_id` filters for token access, RLS for the rest), Buffer GraphQL API, vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-buffer-connections-design.md`

## Global Constraints

- **Tokens never leave the server:** `listBufferConnections` returns `{id, label}`-shaped rows only; no function returns a decrypted or encrypted token to the client.
- **`user_settings.buffer_token_enc` remains but is never read or written after this branch** (rollback safety; dropping it is out of scope).
- Encryption uses the existing `encryptSecret`/`decryptSecret` (`lib/crypto/secrets.ts`) — the migration backfill copies the ENCRYPTED value verbatim (valid: encrypted at rest).
- Token-table access uses the admin client with explicit `.eq("user_id", ...)` filters, matching `lib/settings/user-secrets.ts`; UI-facing rows (categories) keep using the RLS server client.
- The three legacy categories are NOT auto-migrated to new channels — the human re-picks them (their channels belong to a token we don't have yet). The backfill only points existing categories at the user's Default connection.
- Existing suite (184 tests at plan time) stays green; battery = `npx vitest run`, `npx tsc --noEmit`, `npm run build`, `npx eslint .` (pre-existing findings only: the post-composer set-state-in-effect error and the import-athena-legacy warning).
- **This is NOT the Next.js you know** (AGENTS.md): mirror existing conventions; check `node_modules/next/dist/docs/` when unsure.
- Migration 0012 is a file only — applied to Supabase at deploy time, BEFORE the code deploy (the connections UI queries the new table).

---

### Task 1: Migration 0012 and types

**Files:**
- Create: `supabase/migrations/0012_buffer_connections.sql`
- Modify: `lib/types.ts` (new `BufferConnection`; `Category.buffer_connection_id`; `Post` columns)
- Modify: `lib/categories.ts` (`CategoryFields.buffer_connection_id`)
- Modify: `app/(app)/config/actions.ts` + `app/(app)/config/category-manager.tsx` + `app/api/categories/draft/route.ts` (compile-level: thread the new `CategoryFields` field with existing-value fallbacks; the real UI lands in Task 3)
- Test: `tests/categories.test.ts` (extend)

**Interfaces:**
- Produces: `BufferConnection { id: string; user_id: string; label: string; created_at: string; updated_at: string }` (NO token field); `Category.buffer_connection_id: string | null`; `Post.post_group_id: string; Post.buffer_channel_id: string`; `CategoryFields.buffer_connection_id: string` (`""` = none, mapped to `null` at write time).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0012_buffer_connections.sql
-- Post Menu phase 1 (spec 2026-07-28-buffer-connections-design.md).
-- Buffer connections become first-class: N named personal keys per user.
-- user_settings.buffer_token_enc remains on disk but is no longer read or
-- written after this migration's code ships (rollback safety; drop later).

create table buffer_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  buffer_token_enc text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table buffer_connections enable row level security;
create policy "owner all" on buffer_connections
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Backfill: every user with a token gets one connection. The value is
-- already encrypted at rest, so a verbatim copy is a valid token row.
insert into buffer_connections (user_id, label, buffer_token_enc)
select user_id, 'Default', buffer_token_enc
from user_settings where buffer_token_enc <> '';

-- A category's home connection. on delete set null: removing a connection
-- surfaces as "re-pick this category's channel" in the editor, never a
-- dangling reference.
alter table categories
  add column buffer_connection_id uuid references buffer_connections(id) on delete set null;

update categories c
set buffer_connection_id = bc.id
from buffer_connections bc
where bc.user_id = c.user_id and bc.label = 'Default' and c.buffer_channel_id <> '';

-- Phase 2-3 groundwork: one posts row per Buffer update, groupable later;
-- and a record of which channel the update went to.
alter table posts add column post_group_id uuid not null default gen_random_uuid();
alter table posts add column buffer_channel_id text not null default '';
```

- [ ] **Step 2: Write the failing test**

Append to `tests/categories.test.ts`:

```ts
describe("CategoryFields connection binding", () => {
  it("accepts buffer_connection_id as a plain string", () => {
    expect(() =>
      validateCategoryFields({ ...base, buffer_connection_id: "11111111-1111-1111-1111-111111111111" }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/categories.test.ts`
Expected: FAIL — `CategoryFields` lacks the field.

- [ ] **Step 4: Implement the types**

`lib/types.ts`:
```ts
export interface BufferConnection {
  id: string;
  user_id: string;
  label: string;
  created_at: string;
  updated_at: string;
}
```
`Category` gains `buffer_connection_id: string | null;` (after `buffer_channel_service`). `Post` gains `post_group_id: string;` and `buffer_channel_id: string;` (after `buffer_update_id`).

`lib/categories.ts` — `CategoryFields` gains `buffer_connection_id: string;` (after `buffer_channel_id`; `""` = none). No new validation rules.

Compile-threading (no behavior change yet):
- `app/(app)/config/actions.ts`: `createCategory` insert and `updateCategory` update both write `buffer_connection_id: fields.buffer_connection_id || null,`.
- `app/(app)/config/category-manager.tsx`: `EMPTY` gains `buffer_connection_id: "",`; the initializer gains `buffer_connection_id: category.buffer_connection_id ?? "",`. (The dropdown itself changes in Task 3.)
- `app/api/categories/draft/route.ts`: the full-`CategoryFields` construction gains `buffer_connection_id: existing?.buffer_connection_id ?? "",`. It must NOT join `draftColumns` (the wizard never touches channels).

- [ ] **Step 5: Run tests, typecheck**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0012_buffer_connections.sql lib/types.ts lib/categories.ts "app/(app)/config/actions.ts" "app/(app)/config/category-manager.tsx" "app/api/categories/draft/route.ts" tests/categories.test.ts
git commit -m "feat: buffer_connections schema, category binding, posts grouping columns"
```

---

### Task 2: Connection-aware token library, actions, and connections UI

These change together (the lib's old exports are consumed only by the actions and `buffer-section.tsx`) — replacing them in one task keeps every intermediate state compiling.

**Files:**
- Modify: `lib/settings/buffer.ts` (rework)
- Modify: `app/(app)/config/actions.ts` (replace `saveBufferToken`/`disconnectBufferAction` with connection actions)
- Create: `app/(app)/config/connections-section.tsx`
- Delete: `app/(app)/config/buffer-section.tsx`
- Modify: `app/(app)/config/page.tsx` (fetch connections + per-connection channels; render new section)

**Interfaces:**
- Consumes: Task 1's `BufferConnection`.
- Produces (Tasks 3-4 rely on these):
  - `listBufferConnections(userId: string): Promise<BufferConnection[]>` (never includes tokens)
  - `addBufferConnection(userId: string, label: string, token: string): Promise<void>`
  - `removeBufferConnection(userId: string, connectionId: string): Promise<void>`
  - `getBufferTokenForConnection(userId: string, connectionId: string): Promise<string>` — throws `"This category's Buffer connection is missing — pick one in Config"` when absent/foreign.
  - `getBufferChannelsForConnection(userId: string, connectionId: string): Promise<BufferChannel[]>`
  - `getValidBufferToken(userId)` becomes a shim: exactly one connection → its token; zero → throws `"Add a Buffer connection in Config"`; several → throws `"Multiple Buffer connections — this action must specify one"`. (Task 4 removes its last caller and then deletes it.)
  - Type `ChannelGroup { connectionId: string; label: string; channels: BufferChannel[]; error: string }` exported from `lib/settings/buffer.ts` (`error` non-empty when that connection's channel fetch failed).
  - Server actions: `addBufferConnectionAction(prev, formData)` (fields `label`, `token`) and `removeBufferConnectionAction(connectionId: string)`.

- [ ] **Step 1: Rework `lib/settings/buffer.ts`**

Keep `bufferGraphQL`, the GraphQL queries, and `BufferChannel` usage as-is. Replace the token plumbing:

```ts
export async function listBufferConnections(userId: string): Promise<BufferConnection[]> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("buffer_connections")
    .select("id, user_id, label, created_at, updated_at") // never the token
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`buffer_connections query failed: ${error.message}`);
  return (data ?? []) as BufferConnection[];
}

export async function addBufferConnection(userId: string, label: string, token: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("buffer_connections").insert({
    user_id: userId,
    label: label.trim(),
    buffer_token_enc: encryptSecret(token),
  });
  if (error) throw new Error(`failed to add buffer connection: ${error.message}`);
}

export async function removeBufferConnection(userId: string, connectionId: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from("buffer_connections").delete()
    .eq("id", connectionId).eq("user_id", userId);
  if (error) throw new Error(`failed to remove buffer connection: ${error.message}`);
}

// The boundary every downstream Buffer call goes through (was
// getValidBufferToken; connection-aware since phase 1 of the Post Menu work).
export async function getBufferTokenForConnection(userId: string, connectionId: string): Promise<string> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("buffer_connections").select("buffer_token_enc")
    .eq("id", connectionId).eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`buffer_connections query failed: ${error.message}`);
  if (!data?.buffer_token_enc) {
    throw new Error("This category's Buffer connection is missing — pick one in Config");
  }
  return decryptSecret(data.buffer_token_enc);
}
```

Refactor `getBufferChannels`'s body into a private `fetchChannelsWithToken(token: string): Promise<BufferChannel[]>` (the orgs+channels GraphQL loop verbatim), then:

```ts
export async function getBufferChannelsForConnection(
  userId: string, connectionId: string,
): Promise<BufferChannel[]> {
  return fetchChannelsWithToken(await getBufferTokenForConnection(userId, connectionId));
}

export interface ChannelGroup {
  connectionId: string;
  label: string;
  channels: BufferChannel[];
  error: string; // non-empty when this connection's channel fetch failed
}
```

`getValidBufferToken` becomes the shim described in Interfaces (implemented over `listBufferConnections` + `getBufferTokenForConnection`). Delete `storeBufferToken`, `disconnectBuffer`, `getBufferStatus`, and the old `getBufferChannels` (their callers are updated in this same task).

- [ ] **Step 2: Replace the actions**

In `app/(app)/config/actions.ts`, replace `saveBufferToken`/`disconnectBufferAction` (and their imports) with:

```ts
export async function addBufferConnectionAction(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  const label = String(formData.get("label") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();
  if (!label) return { error: "Name this connection (e.g. the account it belongs to)." };
  if (!token) return { error: "Paste the Buffer personal key." };
  try {
    await addBufferConnection(user.id, label, token);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/config");
  return { ok: true };
}

export async function removeBufferConnectionAction(connectionId: string) {
  const user = await requireUser();
  await removeBufferConnection(user.id, connectionId);
  revalidatePath("/config");
}
```

- [ ] **Step 3: The connections section**

Create `app/(app)/config/connections-section.tsx` (modeled on the old `buffer-section.tsx`'s idioms — `useActionState`, `useTransition`, same Card/Input/Button components), delete `buffer-section.tsx`:

```tsx
"use client";
import { useActionState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { addBufferConnectionAction, removeBufferConnectionAction } from "./actions";
import type { ChannelGroup } from "@/lib/settings/buffer";

export function ConnectionsSection({ groups }: { groups: ChannelGroup[] }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(addBufferConnectionAction, undefined);
  const [removing, startRemove] = useTransition();

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Buffer connections</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No connections yet — add one Buffer account below. You can add several.
          </p>
        )}
        {groups.map((g) => (
          <div key={g.connectionId} className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{g.label}</span>
              {g.error
                ? <Badge variant="destructive">key invalid or expired</Badge>
                : <Badge variant="success">{g.channels.length} channels</Badge>}
            </div>
            <Button
              variant="outline" size="sm" disabled={removing}
              onClick={() => {
                if (!confirm(`Remove "${g.label}"? Categories using its channels will need a new pick.`)) return;
                startRemove(async () => {
                  await removeBufferConnectionAction(g.connectionId);
                  router.refresh();
                });
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <form action={action} className="space-y-2 border-t pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Connection name</Label>
              <Input name="label" placeholder="e.g. Athena account" />
            </div>
            <div>
              <Label>Buffer personal key</Label>
              <Input name="token" type="password" placeholder="Paste the personal key" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Get this from Buffer → Settings → API → Personal Keys, logged into the account you&apos;re adding.
          </p>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add connection"}</Button>
            {state?.ok && <span className="text-sm text-status-success">Added.</span>}
            {state?.error && <span className="text-sm text-destructive">{state.error}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Rewire the page**

`app/(app)/config/page.tsx` — replace the `getBufferStatus`/`getBufferChannels` block with per-connection fetching (parallel, failure-tolerant):

```ts
import { listBufferConnections, getBufferChannelsForConnection, type ChannelGroup } from "@/lib/settings/buffer";
```
```ts
const connections = await listBufferConnections(user.id);
const groups: ChannelGroup[] = await Promise.all(
  connections.map(async (c) => {
    try {
      return { connectionId: c.id, label: c.label, channels: await getBufferChannelsForConnection(user.id, c.id), error: "" };
    } catch (e) {
      return { connectionId: c.id, label: c.label, channels: [], error: e instanceof Error ? e.message : String(e) };
    }
  }),
);
```
Render `<ConnectionsSection groups={groups} />` in place of `<BufferSection ... />`. Keep passing `CategoryManager` a flat `channels` prop for now (`groups.flatMap((g) => g.channels)`) — Task 3 switches it to `groups`.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` — clean (proves no orphaned imports of the deleted functions). `npx vitest run` — all pass. `npm run build` — clean. `npx eslint .` — pre-existing findings only.

- [ ] **Step 6: Commit**

```bash
git add lib/settings/buffer.ts "app/(app)/config/actions.ts" "app/(app)/config/connections-section.tsx" "app/(app)/config/page.tsx"
git rm "app/(app)/config/buffer-section.tsx" 2>/dev/null; git add -A "app/(app)/config"
git commit -m "feat: named Buffer connections with connection-aware token boundary"
```

---

### Task 3: Grouped channel dropdown in the category editor

**Files:**
- Create: `lib/channel-choice.ts` (encode/split helper, pure)
- Modify: `app/(app)/config/category-manager.tsx` (grouped select, warning state)
- Modify: `app/(app)/config/page.tsx` (pass `groups` instead of flat channels)
- Test: `tests/channel-choice.test.ts`

**Interfaces:**
- Consumes: Task 2's `ChannelGroup`.
- Produces: `encodeChannelChoice(connectionId: string, channelId: string, service: string): string` and `decodeChannelChoice(value: string): { connectionId: string; channelId: string; service: string } | null` (null for `""`/malformed). `CategoryManager`/`CategoryEditor` props change from `channels: BufferChannel[]` to `groups: ChannelGroup[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { encodeChannelChoice, decodeChannelChoice } from "@/lib/channel-choice";

describe("channel choice encoding", () => {
  it("round-trips", () => {
    const v = encodeChannelChoice("conn-1", "chan-9", "linkedin");
    expect(decodeChannelChoice(v)).toEqual({ connectionId: "conn-1", channelId: "chan-9", service: "linkedin" });
  });
  it("returns null for empty and malformed values", () => {
    expect(decodeChannelChoice("")).toBeNull();
    expect(decodeChannelChoice("just-one-part")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/channel-choice.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

`lib/channel-choice.ts`:
```ts
// One <select> option must carry three values (connection, channel, service).
// "|" is safe: Buffer ids are alphanumeric and services are single words.
export function encodeChannelChoice(connectionId: string, channelId: string, service: string): string {
  return `${connectionId}|${channelId}|${service}`;
}

export function decodeChannelChoice(
  value: string,
): { connectionId: string; channelId: string; service: string } | null {
  if (!value) return null;
  const parts = value.split("|");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  return { connectionId: parts[0], channelId: parts[1], service: parts[2] };
}
```

In `category-manager.tsx`: props become `groups: ChannelGroup[]` (thread through `CategoryManager` → `CategoryEditor`); replace the channel select with:

```tsx
<div><Label>Buffer channel</Label>
  {groups.length === 0 ? (
    <p className="text-xs text-muted-foreground">Add a Buffer connection above to choose a channel.</p>
  ) : (
    <select className="block w-full rounded-md border bg-background p-2 text-sm"
      value={form.buffer_connection_id && form.buffer_channel_id
        ? encodeChannelChoice(form.buffer_connection_id, form.buffer_channel_id, form.buffer_channel_service)
        : ""}
      onChange={(e) => {
        const choice = decodeChannelChoice(e.target.value);
        setForm((f) => ({
          ...f,
          buffer_connection_id: choice?.connectionId ?? "",
          buffer_channel_id: choice?.channelId ?? "",
          buffer_channel_service: choice?.service ?? "",
        }));
      }}>
      <option value="">— none —</option>
      {groups.map((g) => (
        <optgroup key={g.connectionId} label={g.error ? `${g.label} (unavailable)` : g.label}>
          {g.channels.map((c) => (
            <option key={c.id} value={encodeChannelChoice(g.connectionId, c.id, c.service)}>
              {c.displayName || c.name} ({c.service})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )}
  {form.buffer_channel_id && !form.buffer_connection_id && (
    <p className="mt-1 text-xs text-destructive">
      This channel belongs to a disconnected or unassigned Buffer account — re-pick it from a connection above.
    </p>
  )}
</div>
```

Also remove the Task 5 (post-copy) save-time service derivation IF it conflicts: the previous `save()` derived `buffer_channel_service` from a flat `channels` list — rework it to derive from `groups.flatMap((g) => g.channels)` with the same fallback semantics, or drop the derivation if the encoded select now guarantees service is always set on change (keep the save-time healing: pre-existing categories still need it — derive from the flat list of all groups' channels).

`page.tsx`: pass `groups={groups}` to `CategoryManager`, drop the flat `channels` prop.

- [ ] **Step 4: Verify**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/channel-choice.ts tests/channel-choice.test.ts "app/(app)/config/category-manager.tsx" "app/(app)/config/page.tsx"
git commit -m "feat: channel picker grouped by Buffer connection"
```

---

### Task 4: Posting path resolves the connection; retire the shim; battery

**Files:**
- Modify: `app/api/posts/create/route.ts`
- Modify: `lib/settings/buffer.ts` (delete `getValidBufferToken` if no callers remain)

**Interfaces:**
- Consumes: `getBufferTokenForConnection` (Task 2); `Category.buffer_connection_id` (Task 1).

- [ ] **Step 1: Rework the posting call**

In `app/api/posts/create/route.ts`, replace the `getValidBufferToken` call:

```ts
if (!cat.buffer_connection_id) {
  return NextResponse.json(
    { error: `category ${cat.key} has no Buffer connection — pick its channel in Config` },
    { status: 400 },
  );
}
// ...
const token = await getBufferTokenForConnection(user.id, cat.buffer_connection_id);
result = await postToBuffer(token, cat.buffer_channel_id, imageUrls, caption);
```

(The null-connection check goes with the route's other validation, before any Buffer call; keep the try/catch structure around the Buffer call itself.) Both `posts` inserts (success and failure paths) gain `buffer_channel_id: cat.buffer_channel_id,` — `post_group_id` defaults itself.

- [ ] **Step 2: Retire the shim**

Run: `grep -rn "getValidBufferToken" --include="*.ts" --include="*.tsx" . | grep -v node_modules` — if the only remaining hits are its definition, delete it from `lib/settings/buffer.ts`. If a caller remains, leave the shim and note the caller in the report.

- [ ] **Step 3: Full battery**

Run: `npx vitest run` — all pass. `npx tsc --noEmit` — clean. `npm run build` — clean. `npx eslint .` — pre-existing findings only.

- [ ] **Step 4: Commit**

```bash
git add app/api/posts/create/route.ts lib/settings/buffer.ts
git commit -m "feat: posting resolves the category's Buffer connection"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §2 → Task 1; §3 → Task 2 (+shim retirement Task 4); §4 → Task 4; §5 → Tasks 2-3; §6 → Tasks 2-4 (error strings specified inline); §7 → Tasks 1, 3 (pure tests) + battery; §8's out-of-scope has no tasks.
- **Type consistency:** `BufferConnection`/`ChannelGroup`/`encodeChannelChoice`/`decodeChannelChoice`/`getBufferTokenForConnection` names match across tasks; `CategoryFields.buffer_connection_id` as `""`-for-none string with `|| null` at write.
- **Known interaction verified at plan time:** the post-copy branch's save-time `buffer_channel_service` healing in `category-manager.tsx` must survive Task 3's prop change (reworked against `groups.flatMap`, noted inline).
- **Deploy order:** migration 0012 BEFORE code deploy (the connections UI queries the new table; the backfill also makes existing posting keep working through the new boundary).
- Human verification post-merge: add the second Buffer login as a connection, re-pick the three legacy categories' channels, post one image from one of them.
