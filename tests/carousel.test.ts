import { describe, expect, it } from "vitest";
import {
  pickCaption, selectAutoFill, buildCreatePostMutation, findSupersededGenerationIds,
  findWrongAnchorGenerationIds, resolveInitialCaption, resolveValidSlides,
  postedSlideIndexesByIdea, type Postable, type PostedSlideJoinRow,
} from "@/lib/athena/carousel";

function postable(overrides: Partial<Postable>): Postable {
  return {
    generation_id: "g1", idea_id: "i1", idea_created_at: "2026-07-01T00:00:00Z",
    public_url: "https://res.cloudinary.com/x/a.jpg", concept: "c",
    slide_index: 0, slide_count: 1, post_text: "",
    ...overrides,
  };
}

describe("pickCaption", () => {
  it("picks a variant deterministically via injected rand", () => {
    expect(pickCaption("a || b || c", () => 0)).toBe("a");
    expect(pickCaption("a || b || c", () => 0.99)).toBe("c");
  });
  it("trims variants and drops empties", () => {
    expect(pickCaption("  hello  ||  || ", () => 0)).toBe("hello");
  });
  it("returns empty string for empty/whitespace input", () => {
    expect(pickCaption("", () => 0)).toBe("");
    expect(pickCaption("  ||  ", () => 0)).toBe("");
  });
});

describe("selectAutoFill", () => {
  it("returns oldest n by idea_created_at", () => {
    const items = [
      postable({ generation_id: "g3", idea_created_at: "2026-07-03T00:00:00Z" }),
      postable({ generation_id: "g1", idea_created_at: "2026-07-01T00:00:00Z" }),
      postable({ generation_id: "g2", idea_created_at: "2026-07-02T00:00:00Z" }),
    ];
    expect(selectAutoFill(items, 2).map((p) => p.generation_id)).toEqual(["g1", "g2"]);
  });
  it("returns fewer than n when not enough", () => {
    expect(selectAutoFill([postable({})], 5)).toHaveLength(1);
  });
  it("does not mutate its input", () => {
    const items = [
      postable({ generation_id: "g2", idea_created_at: "2026-07-02T00:00:00Z" }),
      postable({ generation_id: "g1", idea_created_at: "2026-07-01T00:00:00Z" }),
    ];
    selectAutoFill(items, 2);
    expect(items[0].generation_id).toBe("g2");
  });
});

describe("buildCreatePostMutation", () => {
  it("builds the Workflow C mutation with caption as a variable", () => {
    const { query, variables } = buildCreatePostMutation(
      "chan1", ["https://a/1.jpg", "https://a/2.jpg"], 'my "caption"\nline2',
    );
    expect(variables).toEqual({ text: 'my "caption"\nline2' });
    expect(query).toContain("mutation CreatePost($text: String!)");
    expect(query).toContain("text: $text");
    expect(query).toContain('channelId: "chan1"');
    expect(query).toContain("schedulingType: automatic");
    expect(query).toContain("mode: addToQueue");
    expect(query).toContain('{ image: { url: "https://a/1.jpg" } }');
    expect(query).toContain('{ image: { url: "https://a/2.jpg" } }');
    expect(query).toContain("PostActionSuccess");
    expect(query).toContain("MutationError");
    // caption must never be interpolated into the query body
    expect(query).not.toContain("my ");
  });
});

describe("selectAutoFill with multi-slide ideas", () => {
  const p = (id: string, ideaId: string, created: string, slideCount: number) => ({
    generation_id: id, idea_id: ideaId, idea_created_at: created,
    public_url: `u/${id}`, concept: "c", slide_index: 0, slide_count: slideCount,
    post_text: "",
  });

  it("skips slides belonging to a multi-slide carousel", () => {
    const pool = [
      p("a", "i1", "2026-01-01", 5),
      p("b", "i2", "2026-01-02", 1),
      p("c", "i3", "2026-01-03", 1),
    ];
    expect(selectAutoFill(pool, 2).map((x) => x.generation_id)).toEqual(["b", "c"]);
  });

  it("still fills from single-slide ideas oldest first", () => {
    const pool = [
      p("b", "i2", "2026-01-02", 1),
      p("c", "i3", "2026-01-03", 1),
      p("a", "i1", "2026-01-01", 1),
    ];
    expect(selectAutoFill(pool, 2).map((x) => x.generation_id)).toEqual(["a", "b"]);
  });

  it("returns nothing rather than a scrambled carousel", () => {
    expect(selectAutoFill([p("a", "i1", "2026-01-01", 5)], 5)).toEqual([]);
  });
});

describe("findSupersededGenerationIds", () => {
  const sib = (
    id: string, ideaId: string, slideIndex: number, status: string, created: string,
    anchorGenerationId: string | null = null,
  ) => ({
    id, idea_id: ideaId, slide_index: slideIndex,
    anchor_generation_id: anchorGenerationId, status, created_at: created,
  });

  it("does not supersede a slide because a different, newer slide in the same idea succeeded", () => {
    // The exact regression this fixes: idea i1 has slide 0 (selected, older)
    // and slide 3 (not selected, newer). Per-idea comparison would have
    // wrongly flagged slide 0 as superseded by slide 3.
    const selected = [{ id: "s0", idea_id: "i1", slide_index: 0 }];
    const siblings = [
      sib("s0", "i1", 0, "succeeded", "2026-01-01T00:00:00Z"),
      sib("s3", "i1", 3, "succeeded", "2026-01-05T00:00:00Z"),
    ];
    expect(findSupersededGenerationIds(selected, siblings)).toEqual([]);
  });

  it("flags a slide superseded by a newer succeeded retry of the same slide", () => {
    const selected = [{ id: "old", idea_id: "i1", slide_index: 0 }];
    const siblings = [
      sib("old", "i1", 0, "succeeded", "2026-01-01T00:00:00Z"),
      sib("new", "i1", 0, "succeeded", "2026-01-02T00:00:00Z"),
    ];
    expect(findSupersededGenerationIds(selected, siblings)).toEqual(["old"]);
  });

  it("handles slides with differing retry counts independently", () => {
    // slide 0 has two succeeded rows (a retried anchor); slide 1 has one,
    // anchored to the newest slide-0 row. Selecting the newest slide 0 and
    // the only slide 1 should both pass.
    const selected = [
      { id: "s0-newest", idea_id: "i1", slide_index: 0 },
      { id: "s1-only", idea_id: "i1", slide_index: 1 },
    ];
    const siblings = [
      sib("s0-first", "i1", 0, "failed", "2026-01-01T00:00:00Z"),
      sib("s0-newest", "i1", 0, "succeeded", "2026-01-02T00:00:00Z"),
      sib("s1-only", "i1", 1, "succeeded", "2026-01-02T00:05:00Z", "s0-newest"),
    ];
    expect(findSupersededGenerationIds(selected, siblings)).toEqual([]);
  });

  it("collapses to the old per-idea behaviour for a legacy single-slide idea", () => {
    const selected = [{ id: "g1", idea_id: "i1", slide_index: 0 }];
    const siblings = [sib("g1", "i1", 0, "succeeded", "2026-01-01T00:00:00Z")];
    expect(findSupersededGenerationIds(selected, siblings)).toEqual([]);
  });

  it("flags old-anchor siblings as superseded once a new anchor succeeds, even though they remain the newest succeeded row for their own slide index", () => {
    // Finding 4's regression case: a completed 3-slide carousel is
    // regenerated via "Regenerate…" on the anchor. The new anchor succeeds;
    // its own siblings haven't landed yet. Per-slide-only comparison (no
    // anchor scope) would pass this selection — pairing the new anchor with
    // the old anchor's leftover slides — which is precisely the silently-
    // broken carousel spec §5.6 exists to prevent.
    const selected = [
      { id: "anchorB", idea_id: "i1", slide_index: 0 },
      { id: "old-s1", idea_id: "i1", slide_index: 1 },
      { id: "old-s2", idea_id: "i1", slide_index: 2 },
    ];
    const siblings = [
      sib("anchorA", "i1", 0, "succeeded", "2026-01-01T00:00:00Z"),
      sib("old-s1", "i1", 1, "succeeded", "2026-01-01T00:01:00Z", "anchorA"),
      sib("old-s2", "i1", 2, "succeeded", "2026-01-01T00:02:00Z", "anchorA"),
      sib("anchorB", "i1", 0, "succeeded", "2026-01-02T00:00:00Z"),
    ];
    expect(findSupersededGenerationIds(selected, siblings)).toEqual(["old-s1", "old-s2"]);
  });
});

describe("findWrongAnchorGenerationIds", () => {
  const sib = (
    id: string, ideaId: string, slideIndex: number, status: string, created: string,
    anchorGenerationId: string | null = null,
  ) => ({
    id, idea_id: ideaId, slide_index: slideIndex,
    anchor_generation_id: anchorGenerationId, status, created_at: created,
  });

  it("allows a deliberately-chosen older retry of a slide under the current anchor", () => {
    // Finding 1: the composer's swap menu offers a slide's older succeeded
    // generations, and posting a hand-picked older retry (not just the
    // newest) must succeed as long as it belongs to the current anchor.
    const selected = [{ id: "s1-old", idea_id: "i1", slide_index: 1 }];
    const siblings = [
      sib("anchor", "i1", 0, "succeeded", "2026-01-01T00:00:00Z"),
      sib("s1-old", "i1", 1, "succeeded", "2026-01-01T00:01:00Z", "anchor"),
      sib("s1-new", "i1", 1, "succeeded", "2026-01-02T00:00:00Z", "anchor"),
    ];
    expect(findWrongAnchorGenerationIds(selected, siblings)).toEqual([]);
  });

  it("rejects a leftover sibling of a superseded anchor", () => {
    const selected = [{ id: "old-s1", idea_id: "i1", slide_index: 1 }];
    const siblings = [
      sib("anchorA", "i1", 0, "succeeded", "2026-01-01T00:00:00Z"),
      sib("old-s1", "i1", 1, "succeeded", "2026-01-01T00:01:00Z", "anchorA"),
      sib("anchorB", "i1", 0, "succeeded", "2026-01-02T00:00:00Z"),
    ];
    expect(findWrongAnchorGenerationIds(selected, siblings)).toEqual(["old-s1"]);
  });

  it("rejects a stale anchor itself once a newer anchor has succeeded", () => {
    const selected = [{ id: "anchorA", idea_id: "i1", slide_index: 0 }];
    const siblings = [
      sib("anchorA", "i1", 0, "succeeded", "2026-01-01T00:00:00Z"),
      sib("anchorB", "i1", 0, "succeeded", "2026-01-02T00:00:00Z"),
    ];
    expect(findWrongAnchorGenerationIds(selected, siblings)).toEqual(["anchorA"]);
  });

  it("allows the current anchor plus its current siblings regardless of retry age", () => {
    const selected = [
      { id: "anchor", idea_id: "i1", slide_index: 0 },
      { id: "s1-old", idea_id: "i1", slide_index: 1 },
      { id: "s2", idea_id: "i1", slide_index: 2 },
    ];
    const siblings = [
      sib("anchor", "i1", 0, "succeeded", "2026-01-01T00:00:00Z"),
      sib("s1-old", "i1", 1, "succeeded", "2026-01-01T00:01:00Z", "anchor"),
      sib("s1-new", "i1", 1, "succeeded", "2026-01-03T00:00:00Z", "anchor"),
      sib("s2", "i1", 2, "succeeded", "2026-01-01T00:02:00Z", "anchor"),
    ];
    expect(findWrongAnchorGenerationIds(selected, siblings)).toEqual([]);
  });
});

const gen = (
  id: string, slide_index: number, anchor: string | null,
  created_at: string, status = "succeeded",
) => ({ id, idea_id: "i1", slide_index, anchor_generation_id: anchor, status, created_at });

describe("resolveValidSlides", () => {
  it("resolves a complete carousel in slide order", () => {
    const out = resolveValidSlides(3, [
      gen("a", 0, null, "2026-01-01"),
      gen("b", 1, "a", "2026-01-02"),
      gen("c", 2, "a", "2026-01-03"),
    ]);
    expect(out.map((s) => s.slideIndex)).toEqual([0, 1, 2]);
    expect(out.map((s) => s.generationId)).toEqual(["a", "b", "c"]);
  });

  it("returns null for a slide with no succeeded generation", () => {
    const out = resolveValidSlides(3, [gen("a", 0, null, "2026-01-01"), gen("b", 1, "a", "2026-01-02")]);
    expect(out[2].generationId).toBeNull();
  });

  it("prefers the newest generation for a retried slide", () => {
    const out = resolveValidSlides(2, [
      gen("a", 0, null, "2026-01-01"),
      gen("b", 1, "a", "2026-01-02"),
      gen("b2", 1, "a", "2026-01-05"),
    ]);
    expect(out[1].generationId).toBe("b2");
  });

  it("ignores siblings of a superseded anchor after a re-anchor", () => {
    const out = resolveValidSlides(2, [
      gen("a1", 0, null, "2026-01-01"),
      gen("b1", 1, "a1", "2026-01-02"),
      gen("a2", 0, null, "2026-01-10"), // re-anchored
    ]);
    expect(out[0].generationId).toBe("a2");
    expect(out[1].generationId).toBeNull(); // b1 belonged to the old anchor
  });

  it("ignores failed generations", () => {
    const out = resolveValidSlides(1, [gen("a", 0, null, "2026-01-01", "failed")]);
    expect(out[0].generationId).toBeNull();
  });

  it("fills publicUrl from the provided map", () => {
    const out = resolveValidSlides(1, [gen("a", 0, null, "2026-01-01")], new Map([["a", "https://x/a.png"]]));
    expect(out[0].publicUrl).toBe("https://x/a.png");
  });

  it("handles a single-slide idea", () => {
    const out = resolveValidSlides(1, [gen("a", 0, null, "2026-01-01")]);
    expect(out).toHaveLength(1);
    expect(out[0].generationId).toBe("a");
  });
});

describe("resolveInitialCaption", () => {
  const p = (idea_id: string, post_text: string): Postable => ({
    generation_id: `g-${Math.random()}`, idea_id, idea_created_at: "2026-07-28",
    public_url: "https://x/y.png", concept: "c", slide_index: 0, slide_count: 1,
    post_text,
  });
  const category = { post_caption: "one||two" };

  it("uses the idea's copy when every selected image is that idea and it has copy", () => {
    expect(resolveInitialCaption([p("a", "the copy"), p("a", "the copy")], category)).toBe("the copy");
  });
  it("falls back to rotation for mixed ideas", () => {
    const out = resolveInitialCaption([p("a", "the copy"), p("b", "other")], category);
    expect(["one", "two"]).toContain(out);
  });
  it("falls back to rotation when the idea has no copy", () => {
    const out = resolveInitialCaption([p("a", "")], category);
    expect(["one", "two"]).toContain(out);
  });
  it("falls back to rotation for an empty selection", () => {
    const out = resolveInitialCaption([], category);
    expect(["one", "two"]).toContain(out);
  });
});

describe("buildCreatePostMutation", () => {
  it("uses the queue mode when no time is given", () => {
    const { query } = buildCreatePostMutation("chan-1", ["https://x/a.png"], "hello");
    expect(query).toContain("schedulingType: automatic");
    expect(query).toContain("mode: addToQueue");
  });
  it("passes the caption as a variable, never inlined", () => {
    const { query, variables } = buildCreatePostMutation("chan-1", ["https://x/a.png"], 'has "quotes"');
    expect(variables.text).toBe('has "quotes"');
    expect(query).not.toContain('has "quotes"');
  });
  it("includes every image url as an asset", () => {
    const { query } = buildCreatePostMutation("chan-1", ["https://x/a.png", "https://x/b.png"], "c");
    expect(query).toContain("https://x/a.png");
    expect(query).toContain("https://x/b.png");
  });
  // Buffer's GraphQL docs confirm mode: customScheduled + a `dueAt` ISO 8601
  // (UTC) field for a custom-time post — see
  // https://developers.buffer.com/guides/posts-and-scheduling.html and
  // https://developers.buffer.com/reference.html (CreatePostInput.dueAt,
  // ShareMode.customScheduled).
  it("uses customScheduled mode with dueAt when a time is given, and drops the queue mode", () => {
    const { query } = buildCreatePostMutation(
      "chan-1", ["https://x/a.png"], "c", "2026-03-10T15:00:00.000Z",
    );
    expect(query).toContain("mode: customScheduled");
    expect(query).toContain('dueAt: "2026-03-10T15:00:00.000Z"');
    expect(query).not.toContain("mode: addToQueue");
  });
});

function joinRow(overrides: Partial<PostedSlideJoinRow>): PostedSlideJoinRow {
  return { post_status: "queued", idea_id: "idea-a", slide_index: 0, ...overrides };
}

describe("postedSlideIndexesByIdea", () => {
  it("counts a slide posted via a single-idea post", () => {
    const byIdea = postedSlideIndexesByIdea([joinRow({ idea_id: "idea-a", slide_index: 0 })]);
    expect(byIdea.get("idea-a")).toEqual(new Set([0]));
  });

  it("counts a slide posted via a freeform post spanning several ideas, keyed by the slide's own idea", () => {
    // A freeform post's own `posts.idea_id` is null because it spans ideas,
    // but each post_images row still resolves through its generation to
    // idea B's real idea_id — that's the whole point of not keying on
    // posts.idea_id (Finding: freeform posts silently forgot idea B's slide).
    const byIdea = postedSlideIndexesByIdea([
      joinRow({ idea_id: "idea-a", slide_index: 0 }),
      joinRow({ idea_id: "idea-b", slide_index: 2 }),
    ]);
    expect(byIdea.get("idea-a")).toEqual(new Set([0]));
    expect(byIdea.get("idea-b")).toEqual(new Set([2]));
  });

  it("does not count a slide whose only post row is failed", () => {
    const byIdea = postedSlideIndexesByIdea([joinRow({ post_status: "failed", idea_id: "idea-a", slide_index: 0 })]);
    expect(byIdea.get("idea-a")).toBeUndefined();
  });

  it("counts a slide as posted if ANY of its post rows is non-failed, even if another attempt failed", () => {
    const byIdea = postedSlideIndexesByIdea([
      joinRow({ post_status: "failed", idea_id: "idea-a", slide_index: 0 }),
      joinRow({ post_status: "queued", idea_id: "idea-a", slide_index: 0 }),
    ]);
    expect(byIdea.get("idea-a")).toEqual(new Set([0]));
  });

  it("groups multiple slide indexes under the same idea", () => {
    const byIdea = postedSlideIndexesByIdea([
      joinRow({ idea_id: "idea-a", slide_index: 0 }),
      joinRow({ idea_id: "idea-a", slide_index: 1 }),
    ]);
    expect(byIdea.get("idea-a")).toEqual(new Set([0, 1]));
  });

  it("returns an empty map for no rows", () => {
    expect(postedSlideIndexesByIdea([]).size).toBe(0);
  });
});
