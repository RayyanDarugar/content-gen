import { describe, it, expect } from "vitest";
import { buildIdeaSystemPrompt, buildIdeaUserPrompt } from "@/lib/athena/prompts";

const cats = [
  { key: "SAT_MYTH", style_guide: "Myth style guide text" },
  { key: "COMIC", style_guide: "Comic style guide text" },
];

describe("buildIdeaSystemPrompt", () => {
  it("includes brand rules and each category guide with === headers", () => {
    const s = buildIdeaSystemPrompt(cats);
    expect(s).toContain("creative content strategist for Athena");
    expect(s).toContain("NON-NEGOTIABLE BRAND RULES");
    expect(s).toContain("=== SAT_MYTH ===\nMyth style guide text");
    expect(s).toContain("=== COMIC ===\nComic style guide text");
    expect(s).toContain("Do NOT write a full image-generation prompt");
  });
  it("falls back for a missing style guide", () => {
    const s = buildIdeaSystemPrompt([{ key: "X", style_guide: "" }]);
    expect(s).toContain("=== X ===\n[No style guide — fill in Config]");
  });
});

describe("buildIdeaUserPrompt", () => {
  it("single category", () => {
    expect(buildIdeaUserPrompt(5, ["COMIC"])).toBe(
      "Generate exactly 5 content ideas for the COMIC category.",
    );
  });
  it("multiple categories", () => {
    expect(buildIdeaUserPrompt(10, ["A", "B"])).toBe(
      "Generate exactly 10 content ideas distributed roughly evenly across: A, B.",
    );
  });
});
