import { createMcpHandler } from "mcp-handler";
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadBrandContext } from "@/lib/athena/brand-context";
import { listBufferConnections, getBufferChannelsForConnection } from "@/lib/settings/buffer";

// Every tool-registration task below (8, 9, 11) adds server.registerTool(...)
// calls inside this same callback, closing over `userId` from the
// authenticated request — there is no session state between requests (the
// installed mcp-handler is stateless: no session ids, no Redis), so a fresh
// handler is built per call, matching the app's existing per-request
// admin-client pattern.
async function handleMcp(request: NextRequest): Promise<Response> {
  let userId: string;
  try {
    userId = (await requireUser(request)).id;
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handler = createMcpHandler((server) => {
    server.registerTool(
      "whoami",
      { title: "Who am I", description: "Returns the authenticated user id — used to verify the connection is wired correctly." },
      async () => ({ content: [{ type: "text", text: userId }] }),
    );

    server.registerTool(
      "get_brand_profile",
      { title: "Get brand profile", description: "Read the current brand profile (name, voice, audience, proof points, colors/fonts)." },
      async () => ({ content: [{ type: "text", text: JSON.stringify(await loadBrandContext(userId)) }] }),
    );

    server.registerTool(
      "list_categories",
      { title: "List post types", description: "List every post type (category) the account has defined." },
      async () => {
        const supabase = createAdminSupabase();
        const { data, error } = await supabase.from("categories").select("*").eq("user_id", userId);
        if (error) throw new Error(error.message);
        return { content: [{ type: "text", text: JSON.stringify(data ?? []) }] };
      },
    );

    server.registerTool(
      "get_category",
      { title: "Get post type", description: "Read one post type by its key.", inputSchema: z.object({ key: z.string() }) },
      async ({ key }) => {
        const supabase = createAdminSupabase();
        const { data, error } = await supabase.from("categories").select("*").eq("key", key).eq("user_id", userId).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error(`unknown category ${key}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    server.registerTool(
      "list_ideas",
      {
        title: "List ideas",
        description: "List post ideas, optionally filtered by post type or status.",
        inputSchema: z.object({
          categoryKey: z.string().optional(),
          status: z.enum(["pending_review", "approved", "rejected", "generating", "generated", "posted"]).optional(),
        }),
      },
      async ({ categoryKey, status }) => {
        const supabase = createAdminSupabase();
        let query = supabase.from("ideas").select("*").eq("user_id", userId);
        if (categoryKey) query = query.eq("category_key", categoryKey);
        if (status) query = query.eq("status", status);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        return { content: [{ type: "text", text: JSON.stringify(data ?? []) }] };
      },
    );

    server.registerTool(
      "get_idea",
      { title: "Get idea", description: "Read one idea by id.", inputSchema: z.object({ id: z.string() }) },
      async ({ id }) => {
        const supabase = createAdminSupabase();
        const { data, error } = await supabase.from("ideas").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error(`unknown idea ${id}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    server.registerTool(
      "list_buffer_connections",
      { title: "List Buffer connections", description: "List the account's named Buffer connections (never returns tokens)." },
      async () => ({ content: [{ type: "text", text: JSON.stringify(await listBufferConnections(userId)) }] }),
    );

    server.registerTool(
      "list_buffer_channels",
      {
        title: "List Buffer channels",
        description: "List the connected social channels available on one Buffer connection.",
        inputSchema: z.object({ connectionId: z.string() }),
      },
      async ({ connectionId }) => ({ content: [{ type: "text", text: JSON.stringify(await getBufferChannelsForConnection(userId, connectionId)) }] }),
    );
  });

  return handler(request);
}

export { handleMcp as GET, handleMcp as POST, handleMcp as DELETE };
