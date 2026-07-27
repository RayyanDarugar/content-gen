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
