import { resolveValidSlides, type SiblingGeneration } from "@/lib/athena/carousel";

export interface QueueRow {
  ideaId: string; categoryKey: string; concept: string; postText: string;
  thumbnailUrl: string; readyCount: number; slideCount: number;
}

export function buildQueueRows(
  ideas: {
    id: string; category_key: string; concept: string; post_text: string;
    slides: unknown[]; created_at: string; generations: SiblingGeneration[];
  }[],
  urlById: Map<string, string>,
): QueueRow[] {
  return ideas
    .map((idea) => {
      const slideCount = (idea.slides ?? []).length || 1;
      const resolved = resolveValidSlides(slideCount, idea.generations, urlById);
      const ready = resolved.filter((s) => s.generationId);
      return {
        ideaId: idea.id, categoryKey: idea.category_key, concept: idea.concept,
        postText: idea.post_text ?? "", thumbnailUrl: ready[0]?.publicUrl ?? "",
        readyCount: ready.length, slideCount, createdAt: idea.created_at,
      };
    })
    .filter((r) => r.readyCount > 0)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r): QueueRow => ({
      ideaId: r.ideaId, categoryKey: r.categoryKey, concept: r.concept,
      postText: r.postText, thumbnailUrl: r.thumbnailUrl,
      readyCount: r.readyCount, slideCount: r.slideCount,
    }));
}
