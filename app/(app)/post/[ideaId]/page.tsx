import { notFound } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getBufferChannelsForConnection } from "@/lib/settings/buffer";
import { resolveValidSlides, type Postable } from "@/lib/athena/carousel";
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
  // The legacy blank-select case from the Phase 1 punch list: warn whenever
  // there's no connection at all, or the fetch succeeded but this category's
  // channel isn't in it. A failed fetch is a separate, transient problem —
  // it gets its own message instead of tripping this one.
  const channelMissing =
    !category.buffer_connection_id ||
    (!channelsError && !channels.some((c) => c.id === category.buffer_channel_id));

  // The same per-category postable pool the old /post page built: newest
  // succeeded generation per (idea, slide), so a slide that was retried
  // doesn't shadow its siblings.
  const { data: poolIdeaData } = await supabase
    .from("ideas")
    .select("*, generations(*)")
    .eq("category_key", category.key)
    .in("status", ["generated", "generating", "approved"])
    .order("created_at", { ascending: false });
  const poolIdeas = (poolIdeaData ?? []) as IdeaWithGenerations[];
  const pool: Postable[] = [];
  for (const poolIdea of poolIdeas) {
    const slideCount = (poolIdea.slides ?? []).length || 1;
    const newestBySlide = new Map<number, Generation>();
    for (const g of poolIdea.generations) {
      if (g.status !== "succeeded" || !g.public_url) continue;
      const existing = newestBySlide.get(g.slide_index);
      if (!existing || g.created_at > existing.created_at) newestBySlide.set(g.slide_index, g);
    }
    for (const g of newestBySlide.values()) {
      pool.push({
        generation_id: g.id,
        idea_id: poolIdea.id,
        idea_created_at: poolIdea.created_at,
        public_url: g.public_url,
        concept: poolIdea.concept,
        slide_index: g.slide_index,
        slide_count: slideCount,
        post_text: poolIdea.post_text ?? "",
      });
    }
  }

  const { data: brandRow } = await supabase.from("brand_profiles").select("*").maybeSingle();
  const brand = brandRow as BrandProfile | null;

  const slideCount = (idea.slides ?? []).length || 1;
  const urlById = new Map<string, string>();
  for (const g of idea.generations) {
    if (g.status === "succeeded" && g.public_url) urlById.set(g.id, g.public_url);
  }
  const resolved = resolveValidSlides(slideCount, idea.generations, urlById);

  return (
    <Composer
      idea={idea}
      category={category}
      channel={channel}
      channelMissing={channelMissing}
      channelsError={channelsError}
      resolved={resolved}
      pool={pool}
      brandName={brand?.business_name?.trim() || "Your brand"}
      schedulingEnabled={SCHEDULING_ENABLED}
    />
  );
}
