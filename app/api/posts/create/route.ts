import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { postToBuffer } from "@/lib/athena/buffer";
import { findWrongAnchorGenerationIds, postedSlideIndexesByIdea, type PostedSlideJoinRow } from "@/lib/athena/carousel";
import { getBufferTokenForConnection } from "@/lib/settings/buffer";
import { mediaForPlatform, normalizeService } from "@/lib/platform";
import { summarizeFanOut, sentSlidesByIdea, type ChannelResult } from "@/lib/athena/fan-out";
import type { Category, Generation, Idea } from "@/lib/types";

export const maxDuration = 60;

export interface ChannelInput {
  connectionId: string;
  channelId: string;
  service: string;
  caption: string;
}

function isChannelInput(v: unknown): v is ChannelInput {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).connectionId === "string" &&
    typeof (v as Record<string, unknown>).channelId === "string" &&
    typeof (v as Record<string, unknown>).service === "string" &&
    typeof (v as Record<string, unknown>).caption === "string"
  );
}

export async function createPostForUser(
  userId: string,
  args: {
    categoryKey: string;
    postGroupId: string;
    channels: ChannelInput[];
    baseCaption: string;
    scheduledAt: string | null;
    suppliedPostGroupId: string | null;
    ordered: (Generation & { idea: Idea })[];
    imageUrls: string[];
    singleIdeaId: string | null;
    siblings: Pick<Generation, "id" | "idea_id" | "slide_index" | "anchor_generation_id" | "status" | "created_at">[];
    gens: (Generation & { idea: Idea })[];
    uniqueIdeaIds: string[];
  },
): Promise<{ postGroupId: string; results: ChannelResult[]; allFailed: boolean }> {
  const {
    categoryKey, postGroupId, channels, baseCaption, scheduledAt, suppliedPostGroupId,
    ordered, imageUrls, singleIdeaId, siblings, gens, uniqueIdeaIds,
  } = args;
  const supabase = createAdminSupabase();

  // All validation above runs exactly once, before any Buffer call. From
  // here each channel stands alone (best-effort): a Buffer post cannot be
  // un-posted, so one channel's failure must never stop the others.
  const results: ChannelResult[] = [];
  // Fed to sentSlidesByIdea below (Critical, review) — each channel's own
  // service, so completeness is computed from what each channel actually
  // received (post-truncation), not from the full submitted list.
  const channelOutcomes: { service: string; queued: boolean }[] = [];
  for (const ch of channels) {
    const urls = mediaForPlatform(imageUrls, normalizeService(ch.service));

    // Important (review): a retry re-submits the same post_group_id for
    // just the channels that failed last time. Without this, the failed
    // row from the earlier attempt is never removed, so the group
    // permanently reads "1 queued · 1 failed" and lists the channel twice
    // even after the retry succeeds. Only ever deletes rows already marked
    // "failed" — a channel's earlier successful post is never touched.
    if (suppliedPostGroupId) {
      const { error: cleanupErr } = await supabase
        .from("posts")
        .delete()
        .eq("post_group_id", suppliedPostGroupId)
        .eq("buffer_channel_id", ch.channelId)
        .eq("user_id", userId)
        .eq("status", "failed");
      if (cleanupErr) console.error("posts/create: failed to clean up prior failed row before retry:", cleanupErr.message);
    }

    let r: { success: boolean; postId: string; error: string; rawBody: string };
    try {
      const token = await getBufferTokenForConnection(userId, ch.connectionId);
      r = await postToBuffer(token, ch.channelId, urls, ch.caption, scheduledAt ?? undefined);
    } catch (e) {
      r = { success: false, postId: "", error: e instanceof Error ? e.message : String(e), rawBody: "" };
    }
    channelOutcomes.push({ service: ch.service, queued: r.success });

    // One posts row per channel, all sharing postGroupId.
    const { data: postRow, error: postErr } = await supabase
      .from("posts")
      .insert({
        user_id: userId,
        category_key: categoryKey,
        post_group_id: postGroupId,
        buffer_update_id: r.success ? r.postId : "",
        buffer_channel_id: ch.channelId,
        buffer_channel_service: ch.service,
        caption: ch.caption,
        adapted_from_caption: ch.caption === baseCaption ? "" : baseCaption,
        status: r.success ? "queued" : "failed",
        error: r.success ? "" : (r.error || r.rawBody.slice(0, 2000)),
        idea_id: singleIdeaId,
        scheduled_at: scheduledAt,
      })
      .select()
      .single();
    if (postErr || !postRow) {
      results.push({ channelId: ch.channelId, status: "failed", error: `posted but failed to record: ${postErr?.message}` });
      continue;
    }
    let imagesWarning: string | undefined;
    if (r.success) {
      // post_images rows are inserted ONLY for channels that actually
      // posted — per-channel posted memory reads them, so a failed channel
      // must not look like it published. Critical (review): also only for
      // the PREFIX this channel's own truncation (`urls`, e.g. X's 4-image
      // mosaic cap) actually sent — recording the full `ordered` list here
      // would mark a slide truncated off this channel's payload as
      // "already sent to X" forever, permanently blocking it there even
      // though X never received it. The Buffer post already went out and
      // can't be un-posted, so a failure here can't fail the channel — but
      // silently swallowing it would let the composer's alreadyPosted
      // filter miss these slides and resubmit them to the same channel
      // (see composer.tsx), so retry once, then log loudly and surface a
      // warning rather than mis-tracking it as if nothing happened.
      const images = ordered.slice(0, urls.length).map((g, idx) => ({
        user_id: userId, post_id: postRow.id, generation_id: g.id, sort_order: idx,
      }));
      let imagesErr = (await supabase.from("post_images").insert(images)).error;
      if (imagesErr) imagesErr = (await supabase.from("post_images").insert(images)).error;
      if (imagesErr) {
        console.error(
          "posts/create: post_images insert failed after retry — channel posted but its slides may be offered again:",
          { postId: postRow.id, channelId: ch.channelId, generationIds: images.map((i) => i.generation_id), error: imagesErr.message },
        );
        imagesWarning = "posted but image records failed — this channel's slides may be offered again";
      }
    }
    results.push(
      r.success
        ? { channelId: ch.channelId, status: "queued", bufferUpdateId: r.postId, ...(imagesWarning ? { warning: imagesWarning } : {}) }
        : { channelId: ch.channelId, status: "failed", error: r.error || r.rawBody.slice(0, 500) },
    );
  }

  const summary = summarizeFanOut(results);

  // Completeness rule (Finding 3): an idea is marked posted only when the
  // UNION of slides already posted in prior (non-failed) posts and the
  // slides submitted here covers every declared slide — not just when this
  // one submission does. Without this, a carousel posted 3-of-5 today and
  // finished 2-of-5 tomorrow would never be marked posted: each submission
  // is individually partial even though together they're complete. A
  // "failed" post never reached Buffer, so it doesn't count toward "already
  // posted". The earlier duplicate-slide check guarantees this submission's
  // own slide indexes are counted at most once. Only run when at least one
  // channel actually queued — an all-failed submission posted nothing, so
  // there is nothing new to fold into the completeness union.
  if (summary.queued > 0) {
    // Resolved through post_images -> generations, not posts.idea_id: a
    // freeform post spanning several ideas has idea_id: null on its own post
    // row, so keying off posts.idea_id would silently forget that a slide of
    // idea B went out when it was posted bundled with idea A's slides. Every
    // generation in `siblings` belongs to one of the ideas being completed
    // here, so scoping post_images to those generation ids covers every post
    // — single-idea or freeform, single-channel or multi-channel — that
    // carried any of their slides.
    const { data: priorImagesData, error: priorImagesErr } = await supabase
      .from("post_images")
      .select("generation_id, post:posts(status, buffer_channel_id)")
      .in("generation_id", siblings.map((s) => s.id))
      .eq("user_id", userId);
    if (priorImagesErr) {
      // Buffer posts already went out and can't be un-posted; a failure to
      // check prior posted slides only means completeness can't be updated
      // this round, not that the submission itself failed. Log and leave
      // idea status untouched rather than mis-shaping the response.
      console.error("posts/create: failed to check prior posted slides:", priorImagesErr.message);
    } else {
      const slideBySiblingId = new Map(siblings.map((s) => [s.id, { idea_id: s.idea_id, slide_index: s.slide_index }]));
      const priorPostedSlidesByIdea = postedSlideIndexesByIdea(
        ((priorImagesData ?? []) as unknown as { generation_id: string; post: { status: string; buffer_channel_id: string } | null }[])
          .map((row): PostedSlideJoinRow | null => {
            const slide = slideBySiblingId.get(row.generation_id);
            return slide && row.post
              ? { post_status: row.post.status, idea_id: slide.idea_id, slide_index: slide.slide_index, buffer_channel_id: row.post.buffer_channel_id }
              : null;
          })
          .filter((row): row is PostedSlideJoinRow => row !== null),
      );

      // Critical (review): built from each QUEUED channel's own truncated
      // prefix (channelOutcomes + mediaForPlatform inside sentSlidesByIdea),
      // never from the full submitted `gens` list — a slide X's mosaic cap
      // dropped from the payload must not count as "sent" just because it
      // was part of the request, and a slide submitted only to a channel
      // that failed must not count as sent at all.
      const submittedSlidesByIdea = sentSlidesByIdea(
        ordered.map((g) => ({ idea_id: g.idea_id, slide_index: g.slide_index })),
        imageUrls,
        channelOutcomes,
      );
      const ideaById = new Map<string, Idea>();
      for (const g of gens) if (!ideaById.has(g.idea_id)) ideaById.set(g.idea_id, g.idea);
      const completedIdeaIds = uniqueIdeaIds.filter((id) => {
        const idea = ideaById.get(id)!;
        const slideCount = (idea.slides ?? []).length || 1;
        const submitted = submittedSlidesByIdea.get(id) ?? new Set<number>();
        const prior = priorPostedSlidesByIdea.get(id) ?? new Set<number>();
        return new Set<number>([...submitted, ...prior]).size === slideCount;
      });
      if (completedIdeaIds.length > 0) {
        const { error: ideaErr } = await supabase.from("ideas").update({ status: "posted" }).in("id", completedIdeaIds).eq("user_id", userId);
        if (ideaErr) console.error("posts/create: failed to mark ideas posted:", ideaErr.message);
      }
    }
  }

  // Best-effort: never claim wholesale success or failure for a partial run.
  // 500 only when every channel failed; 200 whenever anything queued.
  return { postGroupId, results, allFailed: summary.allFailed };
}

// Re-runs the exact category/generation/duplicate-slide/anchor validation the
// POST route below performs before calling createPostForUser — kept here
// (not duplicated in the MCP route) so the two callers can never silently
// diverge. Any change to the HTTP route's validation above must be mirrored
// here, and vice versa.
export async function scheduleValidatedPost(
  userId: string,
  input: { categoryKey: string; generationIds: string[]; channels: ChannelInput[]; caption: string; scheduledAt: string; postGroupId: string | null },
): Promise<{ postGroupId: string; results: ChannelResult[] }> {
  const supabase = createAdminSupabase();
  const { data: category, error: catErr } = await supabase
    .from("categories").select("*").eq("key", input.categoryKey).eq("user_id", userId).single();
  if (catErr || !category || !(category as Category).active) throw new Error("unknown or inactive category");

  const { data: gensData, error: genErr } = await supabase
    .from("generations").select("*, idea:ideas(*)").in("id", input.generationIds).eq("user_id", userId);
  if (genErr) throw new Error(genErr.message);
  const gens = (gensData ?? []) as (Generation & { idea: Idea })[];
  if (gens.length !== input.generationIds.length) throw new Error("one or more generations not found");

  const ideaIds = gens.map((g) => g.idea_id);
  const slideKeys = gens.map((g) => `${g.idea_id}:${g.slide_index}`);
  if (new Set(slideKeys).size !== slideKeys.length) throw new Error("duplicate slide in selection");
  for (const g of gens) {
    if (g.status !== "succeeded" || !g.public_url) throw new Error(`generation ${g.id} has no successful image`);
    if (g.idea.status !== "generated" && g.idea.status !== "generating") throw new Error(`idea for generation ${g.id} is not postable (${g.idea.status})`);
    if (g.idea.category_key !== input.categoryKey) throw new Error(`generation ${g.id} belongs to another category`);
  }

  const { data: siblingsData, error: sibErr } = await supabase
    .from("generations").select("id, idea_id, slide_index, anchor_generation_id, status, created_at")
    .in("idea_id", ideaIds).eq("user_id", userId);
  if (sibErr) throw new Error(sibErr.message);
  const siblings = (siblingsData ?? []) as Pick<Generation, "id" | "idea_id" | "slide_index" | "anchor_generation_id" | "status" | "created_at">[];
  const wrongAnchor = findWrongAnchorGenerationIds(gens.map((g) => ({ id: g.id, idea_id: g.idea_id, slide_index: g.slide_index })), siblings);
  if (wrongAnchor.length > 0) throw new Error(`generation ${wrongAnchor[0]} does not belong to its idea's current anchor`);

  const byId = new Map(gens.map((g) => [g.id, g]));
  const ordered = input.generationIds.map((id) => byId.get(id)!);
  const imageUrls = ordered.map((g) => g.public_url);
  const uniqueIdeaIds = Array.from(new Set(ideaIds));
  const singleIdeaId = uniqueIdeaIds.length === 1 ? uniqueIdeaIds[0] : null;
  const postGroupId = input.postGroupId ?? randomUUID();

  const { postGroupId: pg, results } = await createPostForUser(userId, {
    categoryKey: input.categoryKey, postGroupId, channels: input.channels, baseCaption: input.caption,
    scheduledAt: input.scheduledAt, suppliedPostGroupId: input.postGroupId, ordered, imageUrls,
    singleIdeaId, siblings, gens, uniqueIdeaIds,
  });
  return { postGroupId: pg, results };
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryKey: unknown = body?.category_key;
  const generationIds: unknown = body?.generation_ids;
  const channelsInput: unknown = body?.channels;
  if (
    typeof categoryKey !== "string" ||
    !Array.isArray(generationIds) ||
    !generationIds.every((id) => typeof id === "string") ||
    !Array.isArray(channelsInput)
  ) {
    return NextResponse.json(
      { error: "expected { category_key, generation_ids: string[], channels: [{connectionId, channelId, service, caption}] }" },
      { status: 400 },
    );
  }
  if (channelsInput.length === 0) {
    return NextResponse.json({ error: "select at least one channel" }, { status: 400 });
  }
  if (!channelsInput.every(isChannelInput)) {
    return NextResponse.json(
      { error: "each channel needs connectionId, channelId, service, and caption" },
      { status: 400 },
    );
  }
  const channels = channelsInput as ChannelInput[];
  if (new Set(channels.map((c) => c.channelId)).size !== channels.length) {
    return NextResponse.json({ error: "duplicate channel in selection" }, { status: 400 });
  }
  const baseCaption = typeof body?.caption === "string" ? body.caption : "";

  // Normalize (not just validate) before it ever reaches buildCreatePostMutation:
  // scheduled_at is embedded straight into the GraphQL query string like
  // channelId/imageUrls, so it must be canonical ISO 8601 (no stray quotes
  // or injected characters), not the raw client string.
  let scheduledAt: string | null = null;
  if (typeof body?.scheduled_at === "string") {
    const parsed = new Date(body.scheduled_at);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "scheduled_at must be a valid ISO date string" }, { status: 400 });
    }
    if (parsed.getTime() < Date.now()) {
      return NextResponse.json({ error: "scheduled_at must be in the future" }, { status: 400 });
    }
    scheduledAt = parsed.toISOString();
  }

  // A retry supplies post_group_id to reuse the original group; a fresh
  // submission mints a new one so all channels of this submission share it.
  const suppliedPostGroupId =
    typeof body?.post_group_id === "string" && body.post_group_id ? body.post_group_id : null;
  const postGroupId = suppliedPostGroupId ?? randomUUID();

  const supabase = createAdminSupabase();

  const { data: category, error: catErr } = await supabase
    .from("categories").select("*").eq("key", categoryKey).eq("user_id", user.id).single();
  if (catErr || !category || !(category as Category).active) {
    return NextResponse.json({ error: "unknown or inactive category" }, { status: 400 });
  }

  // Count validation is the idea's own resolved slide count, never
  // category.images_per_carousel — a carousel can be posted partial (one
  // slide permanently failed) or freeform (several ideas' surviving slides
  // together). The only universal requirement left is "at least one image";
  // whether a given idea is *complete* is decided per idea below, once we
  // know which idea(s) the submitted generations belong to.
  if (generationIds.length === 0) {
    return NextResponse.json({ error: "select at least one image to post" }, { status: 400 });
  }

  const { data: gensData, error: genErr } = await supabase
    .from("generations")
    .select("*, idea:ideas(*)")
    .in("id", generationIds as string[])
    .eq("user_id", user.id);
  if (genErr) return NextResponse.json({ error: genErr.message }, { status: 500 });
  const gens = (gensData ?? []) as (Generation & { idea: Idea })[];
  if (gens.length !== generationIds.length) {
    return NextResponse.json({ error: "one or more generations not found" }, { status: 400 });
  }

  const ideaIds = gens.map((g) => g.idea_id);
  // Uniqueness is on (idea_id, slide_index), not idea_id alone: the widened
  // pool now legitimately includes several succeeded slides of the same
  // carousel (e.g. the surviving images of one stuck at 4 of 5), and that is
  // exactly the freeform escape hatch spec §5.6/§9 promise. Rejecting on
  // idea_id alone would block posting two slides of the same idea together,
  // which defeats the escape hatch it exists for. What must still be
  // rejected is posting the same image (or the same slide's newest retry)
  // twice.
  const slideKeys = gens.map((g) => `${g.idea_id}:${g.slide_index}`);
  if (new Set(slideKeys).size !== slideKeys.length) {
    return NextResponse.json({ error: "duplicate slide in selection" }, { status: 400 });
  }
  for (const g of gens) {
    if (g.status !== "succeeded" || !g.public_url) {
      return NextResponse.json({ error: `generation ${g.id} has no successful image` }, { status: 400 });
    }
    // A carousel stuck mid-generation (one slide permanently failed) is
    // deliberately left at "generating" forever so its good slides stay
    // visible — see app/api/jobs/poll/route.ts. Mirror that here so the
    // escape hatch it exists for actually works: freeform posting of the
    // slides that did succeed.
    if (g.idea.status !== "generated" && g.idea.status !== "generating") {
      return NextResponse.json({ error: `idea for generation ${g.id} is not postable (${g.idea.status})` }, { status: 400 });
    }
    if (g.idea.category_key !== categoryKey) {
      return NextResponse.json({ error: `generation ${g.id} belongs to another category` }, { status: 400 });
    }
  }

  // Each selected generation must belong to its idea's CURRENT anchor — a
  // deliberately-chosen older retry of a slide under the current anchor is
  // fine (that's what the composer's swap menu offers); a leftover sibling
  // of a SUPERSEDED anchor is not, because mixing anchors is what actually
  // corrupts a carousel's visual identity. See findWrongAnchorGenerationIds.
  const { data: siblingsData, error: sibErr } = await supabase
    .from("generations")
    .select("id, idea_id, slide_index, anchor_generation_id, status, created_at")
    .in("idea_id", ideaIds)
    .eq("user_id", user.id);
  if (sibErr) return NextResponse.json({ error: sibErr.message }, { status: 500 });
  const siblings = (siblingsData ?? []) as Pick<
    Generation, "id" | "idea_id" | "slide_index" | "anchor_generation_id" | "status" | "created_at"
  >[];
  const wrongAnchor = findWrongAnchorGenerationIds(
    gens.map((g) => ({ id: g.id, idea_id: g.idea_id, slide_index: g.slide_index })),
    siblings,
  );
  if (wrongAnchor.length > 0) {
    return NextResponse.json(
      { error: `generation ${wrongAnchor[0]} does not belong to its idea's current anchor` },
      { status: 400 },
    );
  }

  // Preserve the request's carousel order.
  const byId = new Map(gens.map((g) => [g.id, g]));
  const ordered = (generationIds as string[]).map((id) => byId.get(id)!);
  const imageUrls = ordered.map((g) => g.public_url);

  // The single idea's id when every submitted generation belongs to it,
  // else null — a freeform post spanning several ideas isn't "the" idea's
  // post. Also drives the completeness rule below.
  const uniqueIdeaIds = Array.from(new Set(ideaIds));
  const singleIdeaId = uniqueIdeaIds.length === 1 ? uniqueIdeaIds[0] : null;

  const { postGroupId: pg, results, allFailed } = await createPostForUser(user.id, {
    categoryKey, postGroupId, channels, baseCaption, scheduledAt, suppliedPostGroupId,
    ordered, imageUrls, singleIdeaId, siblings, gens, uniqueIdeaIds,
  });
  return NextResponse.json({ postGroupId: pg, results }, { status: allFailed ? 500 : 200 });
}
