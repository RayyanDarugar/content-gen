import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { postToBuffer } from "@/lib/athena/buffer";
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

  const supabase = createAdminSupabase();

  const { data: category, error: catErr } = await supabase
    .from("categories").select("*").eq("key", categoryKey).eq("user_id", user.id).single();
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
    .in("id", generationIds as string[])
    .eq("user_id", user.id);
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
    .in("idea_id", ideaIds)
    .eq("user_id", user.id);
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
      user_id: user.id,
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
      user_id: user.id,
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
  const { error: imagesErr } = await supabase.from("post_images").insert(
    ordered.map((g, idx) => ({ user_id: user.id, post_id: postRow.id, generation_id: g.id, sort_order: idx })),
  );
  if (imagesErr) {
    return NextResponse.json(
      { error: `posted to Buffer (${result.postId}) but failed to record images: ${imagesErr.message}` },
      { status: 500 },
    );
  }
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
