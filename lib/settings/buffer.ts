import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
import type { BufferChannel, BufferConnection } from "@/lib/types";

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

// Shim for callers that haven't been migrated to a connection-scoped call
// yet (Task 4 removes its last caller and then deletes this).
export async function getValidBufferToken(userId: string): Promise<string> {
  const connections = await listBufferConnections(userId);
  if (connections.length === 0) throw new Error("Add a Buffer connection in Config");
  if (connections.length > 1) throw new Error("Multiple Buffer connections — this action must specify one");
  return getBufferTokenForConnection(userId, connections[0].id);
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

async function fetchChannelsWithToken(token: string): Promise<BufferChannel[]> {
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
