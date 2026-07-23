import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
import type { BufferChannel } from "@/lib/types";

interface BufferRow {
  buffer_token_enc: string;
}

async function fetchBufferRow(userId: string): Promise<BufferRow | null> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("user_settings")
    .select("buffer_token_enc")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_settings query failed: ${error.message}`);
  return (data as BufferRow) ?? null;
}

export async function storeBufferToken(userId: string, token: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("user_settings").upsert(
    { user_id: userId, buffer_token_enc: encryptSecret(token) },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`failed to store buffer token: ${error.message}`);
}

export async function getBufferStatus(userId: string): Promise<{ connected: boolean }> {
  const row = await fetchBufferRow(userId);
  return { connected: !!row?.buffer_token_enc };
}

export async function disconnectBuffer(userId: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from("user_settings")
    .update({ buffer_token_enc: "" })
    .eq("user_id", userId);
  if (error) throw new Error(`failed to disconnect buffer: ${error.message}`);
}

// The one function every downstream Buffer call goes through — the stable
// boundary that lets a future OAuth upgrade add expiry/refresh logic here
// without touching postToBuffer, getBufferChannels, or the posting route.
export async function getValidBufferToken(userId: string): Promise<string> {
  const row = await fetchBufferRow(userId);
  if (!row?.buffer_token_enc) throw new Error("Add your Buffer personal key in Config");
  return decryptSecret(row.buffer_token_enc);
}

const GRAPHQL_URL = "https://api.buffer.com";

async function bufferGraphQL<T>(token: string, query: string): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`buffer graphql HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(`buffer graphql errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data as T;
}

export async function getBufferChannels(userId: string): Promise<BufferChannel[]> {
  const token = await getValidBufferToken(userId);
  const orgs = await bufferGraphQL<{ account: { organizations: { id: string }[] } }>(
    token,
    `query GetOrganizations { account { organizations { id name ownerEmail } } }`,
  );
  const orgIds = orgs.account?.organizations?.map((o) => o.id) ?? [];
  const all: BufferChannel[] = [];
  for (const orgId of orgIds) {
    const data = await bufferGraphQL<{ channels: BufferChannel[] }>(
      token,
      `query GetChannels { channels(input: { organizationId: "${orgId}" }) { id name displayName service avatar isQueuePaused } }`,
    );
    if (Array.isArray(data.channels)) all.push(...data.channels);
  }
  return all;
}
