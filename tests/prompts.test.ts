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
  { key: "MYTH", style_guide: "Bold headline over a flat illustration.", output_format: "myth, scene, insight line", images_per_carousel: 3, post_type: "narrative" as const },
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
    const p = buildIdeaSystemPrompt(empty, [{ key: "X", style_guide: "", output_format: "", images_per_carousel: 1, post_type: "narrative" as const }]);
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
  const cats = [{ key: "SAT_MYTH", style_guide: "GUIDE", output_format: "", images_per_carousel: 5, post_type: "narrative" as const }];

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

describe("buildIdeaSystemPrompt — post type", () => {
  const brand = {
    business_name: "Athena", business_description: "SAT prep",
    audience: "parents", voice: "warm", avoid: "AI jargon",
  };
  const cat = (post_type: "independent" | "narrative") => [{
    key: "SAT_MYTH", style_guide: "GUIDE", output_format: "",
    images_per_carousel: 5, post_type,
  }];

  it("tells the model an independent category is one standalone image per idea", () => {
    const p = buildIdeaSystemPrompt(brand, cat("independent"));
    expect(p).toContain("POST TYPE: independent");
    expect(p).toContain('Exactly 1 slide, role "single"');
  });

  it("does not demand a 5-slide story for an independent category", () => {
    const p = buildIdeaSystemPrompt(brand, cat("independent"));
    expect(p).not.toContain("ONE carousel of exactly 5 slides");
  });

  it("asks a narrative category for a carousel of its slide count", () => {
    const p = buildIdeaSystemPrompt(brand, cat("narrative"));
    expect(p).toContain("POST TYPE: narrative");
    expect(p).toContain("ONE carousel of exactly 5 slides");
  });

  it("carries instructions for both types, since a batch can mix them", () => {
    const p = buildIdeaSystemPrompt(brand, [
      ...cat("independent"),
      { key: "BEAGLE", style_guide: "G2", output_format: "", images_per_carousel: 5, post_type: "narrative" as const },
    ]);
    expect(p).toContain("For an INDEPENDENT category");
    expect(p).toContain("For a NARRATIVE category");
  });
});
