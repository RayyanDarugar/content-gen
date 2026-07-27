export interface Postable {
  generation_id: string;
  idea_id: string;
  idea_created_at: string;
  public_url: string;
  concept: string;
  slide_index: number;
  slide_count: number;
}

export function pickCaption(raw: string, rand: () => number = Math.random): string {
  const variants = raw.split("||").map((s) => s.trim()).filter(Boolean);
  if (variants.length === 0) return "";
  return variants[Math.floor(rand() * variants.length)];
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

// A generation is superseded only by a newer succeeded row for its own
// (idea, slide) — not by a newer row anywhere else in the same idea. Before
// carousels, one idea meant one image, so "newest per idea" and "newest per
// slide" were the same check. Now a slide can be retried (failed-anchor
// resubmit, manual regenerate) independently of its siblings, so comparing
// across the whole idea would let, e.g., a freshly-succeeded slide 3 falsely
// supersede an untouched slide 0 in the same carousel.
export function findSupersededGenerationIds(
  selected: { id: string; idea_id: string; slide_index: number }[],
  siblings: { id: string; idea_id: string; slide_index: number; status: string; created_at: string }[],
): string[] {
  const newestBySlide = new Map<string, { id: string; created_at: string }>();
  for (const s of siblings) {
    if (s.status !== "succeeded") continue;
    const key = `${s.idea_id}:${s.slide_index}`;
    const cur = newestBySlide.get(key);
    if (!cur || s.created_at > cur.created_at) {
      newestBySlide.set(key, { id: s.id, created_at: s.created_at });
    }
  }
  return selected
    .filter((g) => newestBySlide.get(`${g.idea_id}:${g.slide_index}`)?.id !== g.id)
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
