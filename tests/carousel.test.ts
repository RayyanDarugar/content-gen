import { describe, expect, it, afterEach } from "vitest";
import {
  pickCaption, selectAutoFill, buildCreatePostMutation, bufferTokenFor,
  type Postable,
} from "@/lib/athena/carousel";

function postable(overrides: Partial<Postable>): Postable {
  return {
    generation_id: "g1", idea_id: "i1", idea_created_at: "2026-07-01T00:00:00Z",
    public_url: "https://res.cloudinary.com/x/a.jpg", concept: "c",
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

describe("bufferTokenFor", () => {
  afterEach(() => {
    delete process.env.BUFFER_TOKEN_1;
    delete process.env.BUFFER_TOKEN_2;
  });
  it("routes account to the matching env token", () => {
    process.env.BUFFER_TOKEN_1 = "t1";
    process.env.BUFFER_TOKEN_2 = "t2";
    expect(bufferTokenFor(1)).toBe("t1");
    expect(bufferTokenFor(2)).toBe("t2");
  });
  it("throws when the token is unset", () => {
    expect(() => bufferTokenFor(1)).toThrow(/BUFFER_TOKEN_1/);
  });
});
