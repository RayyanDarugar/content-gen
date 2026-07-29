import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { postToBuffer } from "@/lib/athena/buffer";
import { findWrongAnchorGenerationIds, postedSlideIndexesByIdea, type PostedSlideJoinRow } from "@/lib/athena/carousel";
import { getBufferTokenForConnection } from "@/lib/settings/buffer";
import type { Category, Generation, Idea } from "@/lib/types";

export const maxDuration = 60;

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

  const supabase = createAdminSupabase();

  const { data: category, error: catErr } = await supabase
    .from("categories").select("*").eq("key", categoryKey).eq("user_id", user.id).single();
  if (catErr || !category || !(category as Category).active) {
    return NextResponse.json({ error: "unknown or inactive category" }, { status: 400 });
  }
  const cat = category as Category;

  if (!cat.buffer_connection_id) {
    return NextResponse.json(
      { error: `category ${cat.key} has no Buffer connection — pick its channel in Config` },
      { status: 400 },
    );
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

  let result;
  try {
    const token = await getBufferTokenForConnection(user.id, cat.buffer_connection_id);
    result = await postToBuffer(token, cat.buffer_channel_id, imageUrls, caption, scheduledAt ?? undefined);
  } catch (e) {
    result = { success: false, postId: "", error: e instanceof Error ? e.message : String(e), rawBody: "" };
  }

  if (!result.success) {
    await supabase.from("posts").insert({
      user_id: user.id,
      category_key: categoryKey,
      caption,
      status: "failed",
      error: result.error || result.rawBody.slice(0, 2000),
      buffer_channel_id: cat.buffer_channel_id,
      idea_id: singleIdeaId,
      scheduled_at: scheduledAt,
    });
    console.error("buffer post failed:", result.error, result.rawBody.slice(0, 500));
    return NextResponse.json({ error: `Buffer post failed: ${result.error}` }, { status: 500 });
  }

  const { data: postRow, error: postErr } = await supabase
    .from("posts")
    .insert({
      user_id: user.id,
      category_key: categoryKey,
      buffer_update_id: result.postId,
      caption,
      status: "queued",
      buffer_channel_id: cat.buffer_channel_id,
      idea_id: singleIdeaId,
      scheduled_at: scheduledAt,
    })
    .select()
    .single();
  if (postErr || !postRow) {
    return NextResponse.json(
      { error: `posted to Buffer (${result.postId}) but failed to record post: ${postErr?.message}` },
      { status: 500 },
    );
  }
  const { error: imagesErr } = await supabase.from("post_images").insert(
    ordered.map((g, idx) => ({ user_id: user.id, post_id: postRow.id, generation_id: g.id, sort_order: idx })),
  );
  if (imagesErr) {
    return NextResponse.json(
      { error: `posted to Buffer (${result.postId}) but failed to record images: ${imagesErr.message}` },
      { status: 500 },
    );
  }
  // Completeness rule (Finding 3): an idea is marked posted only when the
  // UNION of slides already posted in prior (non-failed) posts and the
  // slides submitted here covers every declared slide — not just when this
  // one submission does. Without this, a carousel posted 3-of-5 today and
  // finished 2-of-5 tomorrow would never be marked posted: each submission
  // is individually partial even though together they're complete. A
  // "failed" post never reached Buffer, so it doesn't count toward "already
  // posted". The earlier duplicate-slide check guarantees this submission's
  // own slide indexes are counted at most once.
  //
  // Resolved through post_images -> generations, not posts.idea_id: a
  // freeform post spanning several ideas has idea_id: null on its own post
  // row, so keying off posts.idea_id would silently forget that a slide of
  // idea B went out when it was posted bundled with idea A's slides. Every
  // generation in `siblings` belongs to one of the ideas being completed
  // here, so scoping post_images to those generation ids covers every post
  // — single-idea or freeform — that carried any of their slides.
  const { data: priorImagesData, error: priorImagesErr } = await supabase
    .from("post_images")
    .select("generation_id, post:posts(status)")
    .in("generation_id", siblings.map((s) => s.id))
    .eq("user_id", user.id)
    .neq("post_id", postRow.id);
  if (priorImagesErr) {
    return NextResponse.json(
      { error: `posted (${result.postId}) but failed to check prior posted slides: ${priorImagesErr.message}` },
      { status: 500 },
    );
  }
  const slideBySiblingId = new Map(siblings.map((s) => [s.id, { idea_id: s.idea_id, slide_index: s.slide_index }]));
  const priorPostedSlidesByIdea = postedSlideIndexesByIdea(
    ((priorImagesData ?? []) as unknown as { generation_id: string; post: { status: string } | null }[])
      .map((row): PostedSlideJoinRow | null => {
        const slide = slideBySiblingId.get(row.generation_id);
        return slide && row.post
          ? { post_status: row.post.status, idea_id: slide.idea_id, slide_index: slide.slide_index }
          : null;
      })
      .filter((row): row is PostedSlideJoinRow => row !== null),
  );

  const submittedSlidesByIdea = new Map<string, Set<number>>();
  for (const g of gens) {
    const set = submittedSlidesByIdea.get(g.idea_id) ?? new Set<number>();
    set.add(g.slide_index);
    submittedSlidesByIdea.set(g.idea_id, set);
  }
  const ideaById = new Map<string, Idea>();
  for (const g of gens) {
    if (!ideaById.has(g.idea_id)) ideaById.set(g.idea_id, g.idea);
  }
  const completedIdeaIds = uniqueIdeaIds.filter((id) => {
    const idea = ideaById.get(id)!;
    const slideCount = (idea.slides ?? []).length || 1;
    const submitted = submittedSlidesByIdea.get(id) ?? new Set<number>();
    const prior = priorPostedSlidesByIdea.get(id) ?? new Set<number>();
    const union = new Set<number>([...submitted, ...prior]);
    return union.size === slideCount;
  });

  if (completedIdeaIds.length > 0) {
    const { error: ideaErr } = await supabase
      .from("ideas").update({ status: "posted" }).in("id", completedIdeaIds).eq("user_id", user.id);
    if (ideaErr) {
      return NextResponse.json(
        { error: `posted (${result.postId}) but failed to mark ideas: ${ideaErr.message}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ post_id: postRow.id, buffer_update_id: result.postId });
}
