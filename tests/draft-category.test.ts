import { describe, expect, it } from "vitest";
import {
  DraftTurnOutput, normalizeDraft, categoryToDraft,
  buildDraftSystemPrompt, toAnthropicMessages,
  type DraftTurn, type NormalizedDraft,
} from "@/lib/athena/draft-category";
import type { BrandContext } from "@/lib/athena/prompts";

const brand: BrandContext = {
  business_name: "Athena",
  business_description: "An SAT prep platform that teaches like a personal tutor.",
  audience: "Parents of high-schoolers",
  voice: "Warm, encouraging, plain-spoken",
  avoid: "AI-powered, dashboards, analytics",
};

const rawDraft = {
  name: "Myth Busters",
  style_guide: "Flat illustration, cream background.",
  output_format: "myth, debunk, insight",
  post_type: "narrative" as const,
  role_guides: { hook: "Orange MYTH tag", beat: "", payoff: "  ", single: "" },
  images_per_carousel: 5,
  aspect_ratio: "4:5",
  caption_guide: "Punchy first person.",
};

describe("DraftTurnOutput", () => {
  it("parses a full turn object", () => {
    const parsed = DraftTurnOutput.parse({ assistant_message: "Here's a start.", ...rawDraft });
    expect(parsed.name).toBe("Myth Busters");
  });
  it("rejects an unknown post_type", () => {
    expect(() =>
      DraftTurnOutput.parse({ assistant_message: "x", ...rawDraft, post_type: "story" }),
    ).toThrow();
  });
});

describe("normalizeDraft", () => {
  it("strips empty and whitespace-only role guides", () => {
    const d = normalizeDraft(rawDraft);
    expect(d.role_guides).toEqual({ hook: "Orange MYTH tag" });
  });
  it("clamps a narrative to at least 2 slides", () => {
    const d = normalizeDraft({ ...rawDraft, images_per_carousel: 1 });
    expect(d.images_per_carousel).toBe(2);
  });
  it("does not clamp an independent category", () => {
    const d = normalizeDraft({ ...rawDraft, post_type: "independent", images_per_carousel: 1 });
    expect(d.images_per_carousel).toBe(1);
  });
  it("defaults an empty name and aspect ratio", () => {
    const d = normalizeDraft({ ...rawDraft, name: "  ", aspect_ratio: "" });
    expect(d.name).toBe("Untitled draft");
    expect(d.aspect_ratio).toBe("4:5");
  });
});

describe("categoryToDraft", () => {
  it("maps a category row to a draft, defaulting null role_guides", () => {
    const d = categoryToDraft({
      name: "N", style_guide: "S", output_format: "O", post_type: "independent",
      role_guides: null as never, images_per_carousel: 3, aspect_ratio: "9:16",
      caption_guide: null as never,
    });
    expect(d.role_guides).toEqual({});
    expect(d.aspect_ratio).toBe("9:16");
  });
});

describe("buildDraftSystemPrompt", () => {
  it("injects the brand context", () => {
    const p = buildDraftSystemPrompt(brand);
    expect(p).toContain("Athena");
    expect(p).toContain("Parents of high-schoolers");
  });
  it("constrains screenshot extraction to structure, never visual style", () => {
    const p = buildDraftSystemPrompt(brand);
    expect(p).toContain("ONLY structure and copy pattern");
    expect(p).toContain("NEVER copy its colors, palette, fonts");
  });
  it("treats multiple screenshots as slides of one carousel", () => {
    const p = buildDraftSystemPrompt(brand);
    expect(p).toContain("slides of ONE post, in order");
  });
  it("explains the style_guide vs role_guides split", () => {
    const p = buildDraftSystemPrompt(brand);
    expect(p.toLowerCase()).toContain("every panel");
    expect(p).toContain("single role");
  });
  it("includes the current fields when revising", () => {
    const seed: NormalizedDraft = normalizeDraft(rawDraft);
    const p = buildDraftSystemPrompt(brand, seed);
    expect(p).toContain("revising an existing category");
    expect(p).toContain("Myth Busters");
  });
  it("omits revise framing when starting fresh", () => {
    expect(buildDraftSystemPrompt(brand)).not.toContain("revising an existing category");
  });
});

describe("toAnthropicMessages", () => {
  it("turns user images into image blocks ahead of the text", () => {
    const turns: DraftTurn[] = [
      { role: "user", text: "Like this one", imageUrls: ["https://x/y.png"] },
    ];
    const msgs = toAnthropicMessages(turns);
    expect(msgs[0].role).toBe("user");
    const content = msgs[0].content as { type: string }[];
    expect(content[0].type).toBe("image");
    expect(content[1].type).toBe("text");
  });
  it("turns multiple carousel-slide screenshots into one image block per slide", () => {
    const turns: DraftTurn[] = [
      { role: "user", text: "Like this carousel", imageUrls: ["https://x/slide1.png", "https://x/slide2.png"] },
    ];
    const msgs = toAnthropicMessages(turns);
    const content = msgs[0].content as { type: string }[];
    expect(content[0].type).toBe("image");
    expect(content[1].type).toBe("image");
    expect(content[2].type).toBe("text");
  });
  it("serializes assistant turns as the full draft JSON", () => {
    const draft = normalizeDraft(rawDraft);
    const turns: DraftTurn[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "Here you go.", draft },
    ];
    const msgs = toAnthropicMessages(turns);
    const parsed = JSON.parse(msgs[1].content as string);
    expect(parsed.assistant_message).toBe("Here you go.");
    expect(parsed.name).toBe("Myth Busters");
  });
  it("substitutes placeholder text for an empty user message", () => {
    const msgs = toAnthropicMessages([{ role: "user", text: "", imageUrls: ["https://x/y.png"] }]);
    const content = msgs[0].content as { type: string; text?: string }[];
    expect(content[1].text).toBeTruthy();
  });
});

describe("caption_guide in the draft", () => {
  it("passes through normalizeDraft", () => {
    expect(normalizeDraft(rawDraft).caption_guide).toBe("Punchy first person.");
  });
  it("maps from a category row, defaulting missing to empty", () => {
    const d = categoryToDraft({
      name: "N", style_guide: "S", output_format: "O", post_type: "independent",
      role_guides: {}, images_per_carousel: 3, aspect_ratio: "4:5",
      caption_guide: undefined as never,
    });
    expect(d.caption_guide).toBe("");
  });
  it("appears in the system prompt's field rules", () => {
    expect(buildDraftSystemPrompt(brand)).toContain("caption_guide");
  });
});
