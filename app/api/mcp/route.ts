import { createMcpHandler } from "mcp-handler";
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadBrandContext } from "@/lib/athena/brand-context";
import { listBufferConnections, getBufferChannelsForConnection } from "@/lib/settings/buffer";
import {
  saveBrandProfileForUser,
  createCategoryForUser,
  updateCategoryForUser,
  clearRoleRefUrlForUser,
} from "@/app/(app)/config/actions";
import { setIdeaDecisionForUser, createManualIdeaForUser } from "@/app/(app)/ideas/actions";
import { extractBrandProfileForUser } from "@/app/api/brand/extract/route";
import { draftCategoryTurnForUser } from "@/app/api/categories/draft/route";
import { generateIdeas } from "@/lib/athena/generate-ideas";
import { rewriteCaptionForUser } from "@/app/api/posts/rewrite-caption/route";
import { adaptCaptionForUser } from "@/app/api/posts/adapt-caption/route";

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

    server.registerTool(
      "update_brand_profile",
      {
        title: "Update brand profile",
        description: "Overwrite the brand profile fields (name, description, audience, voice, avoid, proof points, standing, colors, fonts, visual notes).",
        inputSchema: z.object({
          business_name: z.string(), business_description: z.string(), audience: z.string(),
          voice: z.string(), avoid: z.string(), proof_points: z.array(z.string()),
          standing: z.array(z.string()), colors: z.array(z.string()), fonts: z.array(z.string()),
          visual_notes: z.string(),
        }),
      },
      async (fields) => {
        await saveBrandProfileForUser(userId, fields);
        return { content: [{ type: "text", text: "brand profile updated" }] };
      },
    );

    server.registerTool(
      "extract_brand_from_source",
      {
        title: "Extract brand from source",
        description: "Read a website, uploaded documents, and/or conversation turns and have the model draft a brand profile from them. Does not save it — pair with update_brand_profile to persist the result.",
        inputSchema: z.object({
          url: z.string().optional(),
          documentUrls: z.array(z.string()).optional(),
          turns: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).optional(),
        }),
      },
      async ({ url, documentUrls, turns }) => ({
        content: [{
          type: "text",
          text: JSON.stringify(await extractBrandProfileForUser(userId, {
            url: url ?? null,
            documentUrls: documentUrls ?? [],
            turns: turns ?? [],
          })),
        }],
      }),
    );

    // Shared by create_category and update_category — the exact CategoryFields
    // shape from lib/categories.ts, so neither tool can write a row the
    // manual editor couldn't have.
    const categoryFieldsShape = {
      name: z.string(),
      style_guide: z.string(),
      output_format: z.string(),
      style_ref_url: z.string(),
      post_caption: z.string(),
      buffer_channel_id: z.string(),
      buffer_connection_id: z.string(),
      caption_guide: z.string(),
      buffer_channel_service: z.string(),
      images_per_carousel: z.number().int().min(1).max(10),
      aspect_ratio: z.string(),
      active: z.boolean(),
      post_type: z.enum(["independent", "narrative"]),
      role_guides: z.object({
        hook: z.string().optional(),
        beat: z.string().optional(),
        payoff: z.string().optional(),
        single: z.string().optional(),
      }),
    };

    server.registerTool(
      "create_category",
      {
        title: "Create post type",
        description: "Create a new post type (category) with the given fields.",
        inputSchema: z.object(categoryFieldsShape),
      },
      async (fields) => {
        await createCategoryForUser(userId, fields);
        return { content: [{ type: "text", text: "category created" }] };
      },
    );

    server.registerTool(
      "update_category",
      {
        title: "Update post type",
        description: "Overwrite an existing post type's fields (by id).",
        inputSchema: z.object({ id: z.string(), ...categoryFieldsShape }),
      },
      async ({ id, ...fields }) => {
        await updateCategoryForUser(userId, id, fields);
        return { content: [{ type: "text", text: "category updated" }] };
      },
    );

    server.registerTool(
      "clear_role_ref_url",
      {
        title: "Clear role reference image",
        description: "Remove one promoted role reference image from a category, so that role falls back to the category's style_ref_url again.",
        inputSchema: z.object({
          categoryId: z.string(),
          role: z.enum(["hook", "beat", "payoff", "single"]),
        }),
      },
      async ({ categoryId, role }) => {
        await clearRoleRefUrlForUser(userId, categoryId, role);
        return { content: [{ type: "text", text: "role reference cleared" }] };
      },
    );

    server.registerTool(
      "draft_category_turn",
      {
        title: "Draft post type (conversational)",
        description: "Advance a conversational draft of a post type by one turn — the model proposes/updates the category's fields and replies with a short message. Pass categoryId to continue drafting an existing category, styleRefUrl if a new reference image was uploaded this turn, and suggestionId when this draft originated from a format suggestion (writeback only fires on the turn that creates the category).",
        inputSchema: z.object({
          turns: z.array(z.object({
            role: z.enum(["user", "assistant"]),
            text: z.string(),
            imageUrls: z.array(z.string()).optional(),
          })),
          categoryId: z.string().optional(),
          styleRefUrl: z.string().optional(),
          suggestionId: z.string().optional(),
        }),
      },
      async ({ turns, categoryId, styleRefUrl, suggestionId }) => ({
        content: [{
          type: "text",
          text: JSON.stringify(await draftCategoryTurnForUser(userId, {
            turns,
            categoryId: categoryId ?? null,
            styleRefUrl: styleRefUrl ?? null,
            suggestionId: suggestionId ?? null,
          })),
        }],
      }),
    );

    server.registerTool(
      "generate_ideas",
      {
        title: "Generate ideas",
        description: "Generate new AI post ideas for a post type — writes them into the review queue, does not auto-approve.",
        inputSchema: z.object({ categoryKey: z.string(), count: z.number().int().min(1).max(20) }),
      },
      async ({ categoryKey, count }) => ({ content: [{ type: "text", text: JSON.stringify(await generateIdeas(userId, categoryKey, count)) }] }),
    );

    server.registerTool(
      "set_idea_decision",
      {
        title: "Set idea decision",
        description: "Approve or reject a pending idea.",
        inputSchema: z.object({ id: z.string(), decision: z.enum(["approved", "rejected"]) }),
      },
      async ({ id, decision }) => {
        await setIdeaDecisionForUser(userId, id, decision);
        return { content: [{ type: "text", text: "decision set" }] };
      },
    );

    server.registerTool(
      "create_manual_idea",
      {
        title: "Create manual idea",
        description: "Hand-author an idea (already approved) instead of generating one — slide count is not constrained by the category's images_per_carousel.",
        inputSchema: z.object({
          categoryKey: z.string(),
          concept: z.string(),
          slides: z.array(z.object({
            role: z.enum(["hook", "beat", "payoff", "single"]),
            text: z.string(),
            visual: z.string(),
          })),
          postText: z.string().optional(),
        }),
      },
      async ({ categoryKey, concept, slides, postText }) => {
        await createManualIdeaForUser(userId, { categoryKey, concept, slides, postText });
        return { content: [{ type: "text", text: "idea created" }] };
      },
    );

    server.registerTool(
      "rewrite_caption",
      {
        title: "Rewrite post caption",
        description: "Rewrite a post's published copy given a free-text instruction, the post's images, and (optionally) its idea for slide context.",
        inputSchema: z.object({
          categoryKey: z.string(),
          note: z.string(),
          currentText: z.string().optional(),
          imageUrls: z.array(z.string()).optional(),
          ideaId: z.string().optional(),
        }),
      },
      async ({ categoryKey, note, currentText, imageUrls, ideaId }) => ({
        content: [{
          type: "text",
          text: JSON.stringify(await rewriteCaptionForUser(userId, {
            categoryKey,
            note,
            currentText: currentText ?? "",
            imageUrls: imageUrls ?? [],
            ideaId: ideaId ?? null,
          })),
        }],
      }),
    );

    server.registerTool(
      "adapt_caption",
      {
        title: "Adapt post caption",
        description: "Adapt a post's copy to a different platform's conventions (length, hashtags, tone).",
        inputSchema: z.object({
          categoryKey: z.string(),
          baseText: z.string(),
          service: z.string(),
          ideaId: z.string().optional(),
        }),
      },
      async ({ categoryKey, baseText, service, ideaId }) => ({
        content: [{
          type: "text",
          text: JSON.stringify(await adaptCaptionForUser(userId, { categoryKey, baseText, service, ideaId: ideaId ?? null })),
        }],
      }),
    );
  });

  return handler(request);
}

export { handleMcp as GET, handleMcp as POST, handleMcp as DELETE };
