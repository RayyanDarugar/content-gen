import { describe, expect, it } from "vitest";
import {
  buildIdeaSystemPrompt, buildFilterSystemPrompt, buildIdeaUserPrompt,
  type BrandContext,
} from "@/lib/athena/prompts";

const brand: BrandContext = {
  business_name: "Athena",
  business_description: "An SAT prep platform that teaches like a personal tutor.",
  audience: "Parents of high-schoolers",
  voice: "Warm, encouraging, plain-spoken",
  avoid: "AI-powered, dashboards, analytics",
};

const cats = [
  { key: "MYTH", style_guide: "Bold headline over a flat illustration.", output_format: "myth, scene, insight line", images_per_carousel: 3 },
];

describe("buildIdeaSystemPrompt", () => {
  it("injects the brand context fields", () => {
    const p = buildIdeaSystemPrompt(brand, cats);
    expect(p).toContain("Athena");
    expect(p).toContain("Parents of high-schoolers");
    expect(p).toContain("Warm, encouraging, plain-spoken");
    expect(p).toContain("AI-powered, dashboards, analytics");
  });
  it("injects each category's style guide and output format", () => {
    const p = buildIdeaSystemPrompt(brand, cats);
    expect(p).toContain("MYTH");
    expect(p).toContain("Bold headline over a flat illustration.");
    expect(p).toContain("myth, scene, insight line");
  });
  it("degrades gracefully on empty brand and empty category fields", () => {
    const empty: BrandContext = { business_name: "", business_description: "", audience: "", voice: "", avoid: "" };
    const p = buildIdeaSystemPrompt(empty, [{ key: "X", style_guide: "", output_format: "", images_per_carousel: 1 }]);
    expect(typeof p).toBe("string");
    expect(p).toContain("X");
    expect(p).not.toContain("undefined");
  });
});

describe("buildFilterSystemPrompt", () => {
  it("frames the quality check around the brand", () => {
    const p = buildFilterSystemPrompt(brand);
    expect(p).toContain("Athena");
    expect(p).toContain("Parents of high-schoolers");
  });
});

describe("buildIdeaUserPrompt", () => {
  it("handles a single category", () => {
    expect(buildIdeaUserPrompt(3, ["MYTH"])).toContain("MYTH");
  });
  it("handles multiple categories", () => {
    expect(buildIdeaUserPrompt(6, ["A", "B"])).toContain("A, B");
  });
});

describe("buildIdeaSystemPrompt — carousel instructions", () => {
  const brand = {
    business_name: "Athena", business_description: "SAT prep",
    audience: "parents", voice: "warm", avoid: "AI jargon",
  };
  const cats = [{ key: "SAT_MYTH", style_guide: "GUIDE", output_format: "", images_per_carousel: 5 }];

  it("states the required slide count per category", () => {
    expect(buildIdeaSystemPrompt(brand, cats)).toContain("5");
  });

  it("demands sequential dependency between beats", () => {
    expect(buildIdeaSystemPrompt(brand, cats).toLowerCase()).toContain("reorder");
  });

  it("demands structural variety across the batch", () => {
    expect(buildIdeaSystemPrompt(brand, cats).toLowerCase()).toContain("variety");
  });

  it("forbids panel labels in slide text", () => {
    expect(buildIdeaSystemPrompt(brand, cats).toLowerCase()).toContain("no panel numbers");
  });
});
