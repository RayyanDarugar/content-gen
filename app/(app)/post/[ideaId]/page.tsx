import { notFound } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { listBufferConnections, getBufferChannelsForConnection, type ChannelGroup } from "@/lib/settings/buffer";
import { resolveValidSlides, postedSlideIndexesByIdeaAndChannel, type Postable, type PostedSlideJoinRow } from "@/lib/athena/carousel";
import { publishedImageUrl } from "@/lib/athena/published-image";
import { Composer } from "./composer";
import type { BrandProfile, BufferChannel, Category, Generation, Idea } from "@/lib/types";

type IdeaWithGenerations = Idea & { generations: Generation[] };

// Task 5 confirmed Buffer's scheduled-post mutation shape (mode:
// customScheduled + dueAt: DateTime — see lib/athena/carousel.ts), so the
// composer's time picker is enabled.
const SCHEDULING_ENABLED = true;

export default async function ComposerPage({
  params,
}: {
  params: Promise<{ ideaId: string }>;
}) {
  const user = await requireUser();
  const { ideaId } = await params;
  const supabase = await createServerSupabase();

  const { data: ideaData } = await supabase
    .from("ideas").select("*, generations(*)").eq("id", ideaId).maybeSingle();
  const idea = ideaData as IdeaWithGenerations | null;
  if (!idea) notFound();

  const { data: catData } = await supabase
    .from("categories").select("*").eq("key", idea.category_key).maybeSingle();
  const category = catData as Category | null;
  if (!category) notFound();

  let channels: BufferChannel[] = [];
  let channelsError = "";
  if (category.buffer_connection_id) {
    try {
      channels = await getBufferChannelsForConnection(user.id, category.buffer_connection_id);
    } catch (e) {
      channelsError = e instanceof Error ? e.message : String(e);
    }
  }
  const channel = channels.find((c) => c.id === category.buffer_channel_id) ?? null;

  // Every channel of every connection, for the chip row's "+ Add channel"
  // menu — not just the category's own connection. Same per-connection
  // try/catch pattern as app/(app)/config/page.tsx, so one revoked
  // connection's failure doesn't blank out the others.
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
  // The legacy blank-select case from the Phase 1 punch list: warn whenever
  // there's no connection at all, or the fetch succeeded but this category's
  // channel isn't in it. A failed fetch is a separate, transient problem —
  // it gets its own message instead of tripping this one.
  const channelMissing =
    !category.buffer_connection_id ||
    (!channelsError && !channels.some((c) => c.id === category.buffer_channel_id));

  // The same per-category postable pool the old /post page built, now
  // anchor-aware: resolveValidSlides is the single source of slide validity
  // (Global Constraint), so a stale sibling left behind by a re-anchored
  // carousel is never offered here even though it may still be the newest
  // succeeded row for its own slide index. Finding 2: the pre-resolveValidSlides
  // "newest succeeded per (idea, slide)" logic this branch exists to retire.
  const { data: poolIdeaData } = await supabase
    .from("ideas")
    .select("*, generations(*)")
    .eq("category_key", category.key)
    .in("status", ["generated", "generating", "approved"])
    .order("created_at", { ascending: false });
  const poolIdeas = (poolIdeaData ?? []) as IdeaWithGenerations[];
  const pool: Postable[] = [];
  for (const poolIdea of poolIdeas) {
    const poolSlideCount = (poolIdea.slides ?? []).length || 1;
    const poolUrlById = new Map<string, string>();
    for (const g of poolIdea.generations) {
      if (g.status === "succeeded" && publishedImageUrl(g)) poolUrlById.set(g.id, publishedImageUrl(g));
    }
    const poolResolved = resolveValidSlides(poolSlideCount, poolIdea.generations, poolUrlById);
    for (const slide of poolResolved) {
      if (!slide.generationId) continue;
      pool.push({
        generation_id: slide.generationId,
        idea_id: poolIdea.id,
        idea_created_at: poolIdea.created_at,
        public_url: slide.publicUrl,
        concept: poolIdea.concept,
        slide_index: slide.slideIndex,
        slide_count: poolSlideCount,
        post_text: poolIdea.post_text ?? "",
      });
    }
  }

  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").eq("id", category.brand_id).maybeSingle();
  const brand = brandRow as BrandProfile | null;

  const slideCount = (idea.slides ?? []).length || 1;
  const urlById = new Map<string, string>();
  for (const g of idea.generations) {
    if (g.status === "succeeded" && publishedImageUrl(g)) urlById.set(g.id, publishedImageUrl(g));
  }
  const resolved = resolveValidSlides(slideCount, idea.generations, urlById);

  // Finding 3: "remember what went out". Every non-failed post that
  // carried one of this idea's slides has already gone live on Buffer, so
  // that slide must be excluded from what gets re-submitted on reopen — a
  // "failed" post never reached Buffer, so its slides stay eligible.
  //
  // Resolved through post_images -> generations, not posts.idea_id: a
  // freeform post spanning several ideas leaves idea_id: null on its own
  // post row, so keying off it would miss a slide of THIS idea that went
  // out bundled with another idea's slides — reopening this composer would
  // then show it as fresh and double-publish it.
  const generationIds = idea.generations.map((g) => g.id);
  const { data: postImageRows } = generationIds.length
    ? await supabase
        .from("post_images")
        .select("generation_id, post:posts(status, buffer_channel_id)")
        .in("generation_id", generationIds)
    : { data: [] as { generation_id: string; post: { status: string; buffer_channel_id: string } | null }[] };
  const slideIndexByGenId = new Map(idea.generations.map((g) => [g.id, g.slide_index]));
  const postedByIdeaAndChannel = postedSlideIndexesByIdeaAndChannel(
    ((postImageRows ?? []) as { generation_id: string; post: { status: string; buffer_channel_id: string } | null }[])
      .map((row): PostedSlideJoinRow | null => {
        const slideIndex = slideIndexByGenId.get(row.generation_id);
        return slideIndex != null && row.post
          ? {
              post_status: row.post.status,
              idea_id: idea.id,
              slide_index: slideIndex,
              buffer_channel_id: row.post.buffer_channel_id,
            }
          : null;
      })
      .filter((row): row is PostedSlideJoinRow => row !== null),
  );
  // Serialized as a plain object (channelId -> slide indexes) so it can cross
  // the server/client boundary — the composer turns each array back into a
  // Set as needed.
  const postedByChannel: Record<string, number[]> = {};
  for (const [channelId, slideIndexes] of postedByIdeaAndChannel.get(idea.id) ?? new Map()) {
    postedByChannel[channelId] = Array.from(slideIndexes);
  }

  return (
    <Composer
      idea={idea}
      category={category}
      channel={channel}
      channelMissing={channelMissing}
      channelsError={channelsError}
      resolved={resolved}
      pool={pool}
      postedByChannel={postedByChannel}
      groups={groups}
      brandName={brand?.business_name?.trim() || "Your brand"}
      schedulingEnabled={SCHEDULING_ENABLED}
    />
  );
}
