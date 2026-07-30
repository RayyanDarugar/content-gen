import { createMcpHandler } from "mcp-handler";
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadBrandContext } from "@/lib/athena/brand-context";
import { listBufferConnections, getBufferChannelsForConnection, removeBufferConnection } from "@/lib/settings/buffer";
import { saveBrandProfileForUser } from "@/lib/brand-profile";
import {
  createCategoryForUser,
  updateCategoryForUser,
  clearRoleRefUrlForUser,
  deleteCategoryForUser,
} from "@/lib/category-mutations";
import { setIdeaDecisionForUser, createManualIdeaForUser } from "@/lib/idea-mutations";
import { extractBrandProfileForUser } from "@/app/api/brand/extract/route";
import { draftCategoryTurnForUser } from "@/app/api/categories/draft/route";
import { generateIdeas } from "@/lib/athena/generate-ideas";
import { rewriteCaptionForUser } from "@/app/api/posts/rewrite-caption/route";
import { adaptCaptionForUser } from "@/app/api/posts/adapt-caption/route";
import { assertConfirmed } from "@/lib/mcp/confirm";
import { submitGenerations } from "@/lib/athena/submit-generations";
import { resubmitSlide } from "@/lib/athena/resubmit-slide";
import { scheduleValidatedPost } from "@/app/api/posts/create/route";
import { submitStyleRefJobForUser, getStyleRefJobForUser } from "@/lib/style-ref-jobs";

// Matches the longest budget of any route this one fans into (brand/extract,
// categories/draft, posts/rewrite-caption, posts/adapt-caption, ideas/generate
// and images/generate all set 120). Without it this route would run at the
// platform default, and a schedule_post killed part-way through
// createPostForUser's per-channel loop can leave a live Buffer post queued
// with no local `posts` row — a duplicate waiting to happen on retry.
export const maxDuration = 120;

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

    // --- Tier 2: irreversible / credit-spending / live-external-account
    // tools. Every one of these MUST call assertConfirmed (or, for
    // schedule_post, the scheduledAt future-date check) before any Supabase
    // write or external API call — see task-10 self-review in the plan.
    server.registerTool(
      "delete_category",
      {
        title: "Delete post type",
        description: "Permanently delete a post type. Irreversible — always confirm with the user first. Requires confirm: true.",
        inputSchema: z.object({ id: z.string(), confirm: z.boolean().optional() }),
      },
      async ({ id, confirm }) => {
        assertConfirmed({ confirm }, `permanently delete category ${id}`);
        await deleteCategoryForUser(userId, id);
        return { content: [{ type: "text", text: `deleted category ${id}` }] };
      },
    );

    server.registerTool(
      "remove_buffer_connection",
      {
        title: "Remove Buffer connection",
        description: "Disconnect a Buffer connection. Irreversible in-app (the external Buffer/social account itself is unaffected). Requires confirm: true.",
        inputSchema: z.object({ connectionId: z.string(), confirm: z.boolean().optional() }),
      },
      async ({ connectionId, confirm }) => {
        assertConfirmed({ confirm }, `remove Buffer connection ${connectionId}`);
        await removeBufferConnection(userId, connectionId);
        return { content: [{ type: "text", text: `removed connection ${connectionId}` }] };
      },
    );

    server.registerTool(
      "submit_image_generation",
      {
        title: "Generate images",
        description: "Submit ideas for image generation — spends real API credit per image. Requires confirm: true.",
        inputSchema: z.object({ ideaIds: z.array(z.string()).min(1), refinementNotes: z.string().optional(), confirm: z.boolean().optional() }),
      },
      async ({ ideaIds, refinementNotes, confirm }) => {
        assertConfirmed({ confirm }, `submit ${ideaIds.length} idea(s) for image generation (spends API credit)`);
        return { content: [{ type: "text", text: JSON.stringify(await submitGenerations(userId, ideaIds, refinementNotes ?? "")) }] };
      },
    );

    server.registerTool(
      "resubmit_slide",
      {
        title: "Regenerate one slide",
        description: "Regenerate a single slide of a carousel — spends real API credit. Requires confirm: true.",
        inputSchema: z.object({ ideaId: z.string(), slideIndex: z.number().int().min(1), refinementNotes: z.string().optional(), confirm: z.boolean().optional() }),
      },
      async ({ ideaId, slideIndex, refinementNotes, confirm }) => {
        // slideIndex is 0-based internally (see resubmitSlide's own "slide
        // ${slideIndex + 1} is still generating" message) — the confirm
        // summary must show the same 1-based number a human would count, or
        // "regenerate slide 2" would actually spend credit on slide index 2
        // (the third slide) instead of the one the user thinks they approved.
        assertConfirmed({ confirm }, `regenerate slide ${slideIndex + 1} of idea ${ideaId} (spends API credit)`);
        return { content: [{ type: "text", text: JSON.stringify(await resubmitSlide(userId, ideaId, slideIndex, refinementNotes ?? "")) }] };
      },
    );

    server.registerTool(
      "generate_style_ref",
      {
        title: "Generate brand reference image",
        description:
          "Generate a new AI brand style reference image for a post type, grounded in the brand's colors/fonts/visual notes, optionally steered by notes. Fire-and-forget: spends real API credit and completes asynchronously — poll get_style_ref_job with the returned jobId to see when it's done. Requires confirm: true.",
        inputSchema: z.object({
          categoryId: z.string(),
          notes: z.string().optional(),
          confirm: z.boolean().optional(),
        }),
      },
      async ({ categoryId, notes, confirm }) => {
        assertConfirmed(
          { confirm },
          `generate a new brand reference image for category ${categoryId} (spends API credit)`,
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify(await submitStyleRefJobForUser(userId, categoryId, notes)),
          }],
        };
      },
    );

    server.registerTool(
      "get_style_ref_job",
      {
        title: "Get style reference job status",
        description: "Check the status of a style reference image generation previously submitted with generate_style_ref.",
        inputSchema: z.object({ jobId: z.string() }),
      },
      async ({ jobId }) => ({
        content: [{ type: "text", text: JSON.stringify(await getStyleRefJobForUser(userId, jobId)) }],
      }),
    );

    const ScheduleChannelInput = z.object({ connectionId: z.string(), channelId: z.string(), service: z.string(), caption: z.string() });

    server.registerTool(
      "schedule_post",
      {
        title: "Schedule a post",
        description:
          "Schedule generated images to post to one or more connected channels at a future time via Buffer. " +
          "This reaches a real, live social account and cannot be un-posted. scheduled_at is REQUIRED and must be " +
          "in the future — there is no 'post now' tool. Requires confirm: true.",
        inputSchema: z.object({
          categoryKey: z.string(),
          generationIds: z.array(z.string()).min(1),
          channels: z.array(ScheduleChannelInput).min(1),
          caption: z.string(),
          scheduledAt: z.string(),
          postGroupId: z.string().optional(),
          confirm: z.boolean().optional(),
        }),
      },
      async ({ categoryKey, generationIds, channels, caption, scheduledAt, postGroupId, confirm }) => {
        assertConfirmed(
          { confirm },
          `schedule a post to ${channels.length} channel(s) for ${scheduledAt} — this will go out to a live connected account`,
        );
        const parsed = new Date(scheduledAt);
        if (Number.isNaN(parsed.getTime()) || parsed.getTime() < Date.now()) {
          throw new Error("scheduledAt must be a valid ISO date string in the future");
        }
        // Reuses the same lookup/validation the HTTP route performs before
        // calling createPostForUser (Task 5) — see app/api/posts/create/route.ts
        // for the category/generation/sibling queries this must run first.
        const result = await scheduleValidatedPost(userId, {
          categoryKey, generationIds, channels, caption, scheduledAt: parsed.toISOString(), postGroupId: postGroupId ?? null,
        });
        // Every-channel failure is surfaced as a thrown error — the same way
        // every other tool in this file signals failure, and the same way the
        // HTTP route turns allFailed into a 500. Returning the usual
        // success-shaped JSON here would hide a total failure behind a
        // per-channel "status":"failed" an agent has to dig for. The payload
        // is kept in the message because postGroupId is what a retry needs.
        if (result.allFailed) {
          throw new Error(
            `schedule_post failed on every channel — nothing was queued. Retry with postGroupId ` +
              `"${result.postGroupId}" to reuse this post group: ${JSON.stringify(result)}`,
          );
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );
  });

  return handler(request);
}

export { handleMcp as GET, handleMcp as POST, handleMcp as DELETE };
