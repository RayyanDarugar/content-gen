import { describe, expect, it } from "vitest";
import {
  pickCaption, selectAutoFill, buildCreatePostMutation,
  type Postable,
} from "@/lib/athena/carousel";

function postable(overrides: Partial<Postable>): Postable {
  return {
    generation_id: "g1", idea_id: "i1", idea_created_at: "2026-07-01T00:00:00Z",
    public_url: "https://res.cloudinary.com/x/a.jpg", concept: "c",
    slide_index: 0, slide_count: 1,
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
