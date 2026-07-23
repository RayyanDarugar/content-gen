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
  { key: "MYTH", style_guide: "Bold headline over a flat illustration.", output_format: "myth, scene, insight line" },
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
    const p = buildIdeaSystemPrompt(empty, [{ key: "X", style_guide: "", output_format: "" }]);
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
