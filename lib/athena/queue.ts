import { resolveValidSlides, type SiblingGeneration } from "@/lib/athena/carousel";

export interface QueueRow {
  ideaId: string; categoryKey: string; concept: string; postText: string;
  thumbnailUrl: string; readyCount: number; postedCount: number; slideCount: number;
}

export function buildQueueRows(
  ideas: {
    id: string; category_key: string; concept: string; post_text: string;
    slides: unknown[]; created_at: string; generations: SiblingGeneration[];
    // Finding 3: distinct slide indexes already posted in a prior
    // non-failed post for this idea, so the queue can distinguish "posted"
    // from "ready to post" instead of showing a green N/N for an idea
    // that's actually a mix of both.
    posted_slide_indexes?: number[];
  }[],
  urlById: Map<string, string>,
): QueueRow[] {
  return ideas
    .map((idea) => {
      const slideCount = (idea.slides ?? []).length || 1;
      const resolved = resolveValidSlides(slideCount, idea.generations, urlById);
      const posted = new Set(idea.posted_slide_indexes ?? []);
      const readySlides = resolved.filter((s) => s.generationId);
      const unpostedReadySlides = readySlides.filter((s) => !posted.has(s.slideIndex));
      const thumbnailUrl = (unpostedReadySlides[0] ?? readySlides[0])?.publicUrl ?? "";
      return {
        ideaId: idea.id, categoryKey: idea.category_key, concept: idea.concept,
        postText: idea.post_text ?? "", thumbnailUrl,
        readyCount: unpostedReadySlides.length, postedCount: posted.size,
        slideCount, createdAt: idea.created_at,
      };
    })
    .filter((r) => r.readyCount > 0 || r.postedCount > 0)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r): QueueRow => ({
      ideaId: r.ideaId, categoryKey: r.categoryKey, concept: r.concept,
      postText: r.postText, thumbnailUrl: r.thumbnailUrl,
      readyCount: r.readyCount, postedCount: r.postedCount, slideCount: r.slideCount,
    }));
}
