import type { Category } from "@/lib/types";

export interface Postable {
  generation_id: string;
  idea_id: string;
  idea_created_at: string;
  public_url: string;
  concept: string;
  slide_index: number;
  slide_count: number;
  post_text: string;
}

export function pickCaption(raw: string, rand: () => number = Math.random): string {
  const variants = raw.split("||").map((s) => s.trim()).filter(Boolean);
  if (variants.length === 0) return "";
  return variants[Math.floor(rand() * variants.length)];
}

// Spec §5 prefill rule: the caption box starts from the idea's AI-written
// copy only when the whole selection IS that one idea; anything mixed or
// copy-less keeps today's rotating variants.
export function resolveInitialCaption(
  selected: Postable[],
  category: Pick<Category, "post_caption">,
  rand: () => number = Math.random,
): string {
  const ideaIds = new Set(selected.map((s) => s.idea_id));
  if (ideaIds.size === 1) {
    const text = selected[0].post_text.trim();
    if (text) return text;
  }
  return pickCaption(category.post_caption, rand);
}

// Phase A: the default fill deliberately skips multi-slide carousels. All
// slides of one idea share an idea_created_at and nothing here sorts by
// slide_index, so including them would pre-fill a scrambled carousel —
// worse than not offering one. Phase B assembles them in order. The pool
// itself is unfiltered, so every image stays hand-pickable meanwhile.
export function selectAutoFill(postables: Postable[], n: number): Postable[] {
  return [...postables]
    .filter((p) => p.slide_count <= 1)
    .sort((a, b) => a.idea_created_at.localeCompare(b.idea_created_at))
    .slice(0, n);
}

export interface SiblingGeneration {
  id: string;
  idea_id: string;
  slide_index: number;
  anchor_generation_id: string | null;
  status: string;
  created_at: string;
}

export interface SlideResolution {
  slideIndex: number;
  generationId: string | null;
  publicUrl: string;
}

// The single source of truth for "which generation is this slide's current
// image". The queue, the composer, and posts/create all read it, so they
// cannot disagree about whether a carousel is postable. findSupersededGenerationIds
// is implemented over it for the same reason.
//
// Rule: an idea's anchor is the newest succeeded slide-0 generation; a
// non-anchor slide's valid generation is the newest succeeded row whose
// anchor_generation_id equals that anchor's id. Re-anchoring invalidates
// the previous anchor's siblings, even though they remain the newest
// succeeded row for their own slide index — they no longer belong to the
// current anchor.
export function resolveValidSlides(
  slideCount: number,
  siblings: SiblingGeneration[],
  urlById?: Map<string, string>,
): SlideResolution[] {
  const succeeded = siblings.filter((g) => g.status === "succeeded");
  const anchors = succeeded.filter((g) => g.slide_index === 0);
  const anchor = anchors.length
    ? anchors.reduce((newest, g) => (g.created_at > newest.created_at ? g : newest))
    : null;

  const bestForSlide = new Map<number, { id: string; created_at: string }>();
  if (anchor) {
    bestForSlide.set(0, { id: anchor.id, created_at: anchor.created_at });
    for (const g of succeeded) {
      if (g.slide_index === 0 || g.anchor_generation_id !== anchor.id) continue;
      const cur = bestForSlide.get(g.slide_index);
      if (!cur || g.created_at > cur.created_at) {
        bestForSlide.set(g.slide_index, { id: g.id, created_at: g.created_at });
      }
    }
  }

  return Array.from({ length: slideCount }, (_, slideIndex) => {
    const best = bestForSlide.get(slideIndex);
    return {
      slideIndex,
      generationId: best?.id ?? null,
      publicUrl: best ? (urlById?.get(best.id) ?? "") : "",
    };
  });
}

// A generation is superseded unless it is the newest succeeded row for its
// own (idea, slide) *under the idea's current anchor* — not by a newer row
// anywhere else in the same idea, and not by a row that succeeded under a
// previous, now-superseded anchor. Spec §5.6: "A carousel is postable only
// if every slide has a succeeded generation under the same anchor... exact
// rather than count-based." Before carousels, one idea meant one image, so
// "newest per idea" and "newest per slide" were the same check. Now a slide
// can be retried (failed-anchor resubmit, manual regenerate) independently
// of its siblings, and an anchor itself can be regenerated — which must
// invalidate its old siblings even though they are each still the newest
// succeeded row for their own slide index. Without the anchor scope, posting
// a fresh anchor alongside a previous anchor's leftover siblings would pass
// this check: the exact silently-broken carousel the spec exists to prevent.
export function findSupersededGenerationIds(
  selected: { id: string; idea_id: string; slide_index: number }[],
  siblings: SiblingGeneration[],
): string[] {
  const byIdea = new Map<string, SiblingGeneration[]>();
  for (const s of siblings) {
    const arr = byIdea.get(s.idea_id) ?? [];
    arr.push(s);
    byIdea.set(s.idea_id, arr);
  }

  const validIdByKey = new Map<string, string>();
  for (const [ideaId, gens] of byIdea) {
    const slideCount = gens.reduce((max, g) => Math.max(max, g.slide_index + 1), 0);
    const resolved = resolveValidSlides(slideCount, gens);
    for (const slide of resolved) {
      if (slide.generationId) validIdByKey.set(`${ideaId}:${slide.slideIndex}`, slide.generationId);
    }
  }

  return selected
    .filter((g) => validIdByKey.get(`${g.idea_id}:${g.slide_index}`) !== g.id)
    .map((g) => g.id);
}

// Port of n8n Workflow C "Group Into Carousels". channelId and image URLs are
// app-controlled values; the caption is user text and travels as a variable.
export function buildCreatePostMutation(
  channelId: string,
  imageUrls: string[],
  caption: string,
): { query: string; variables: { text: string } } {
  const assetsBlock = imageUrls
    .map((url) => `{ image: { url: "${url}" } }`)
    .join("\n        ");
  const query = `mutation CreatePost($text: String!) {
  createPost(
    input: {
      text: $text
      channelId: "${channelId}"
      schedulingType: automatic
      mode: addToQueue
      assets: [
        ${assetsBlock}
      ]
    }
  ) {
    ... on PostActionSuccess {
      post { id }
    }
    ... on MutationError {
      message
    }
  }
}`;
  return { query, variables: { text: caption } };
}
