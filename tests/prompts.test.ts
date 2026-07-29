import { describe, expect, it } from "vitest";
import {
  buildIdeaSystemPrompt, buildFilterSystemPrompt, buildIdeaUserPrompt,
  platformPresetFor, clampIdeaCount, buildAdaptCaptionSystemPrompt, brandBlock,
  buildBrandExtractSystemPrompt,
  type BrandContext,
} from "@/lib/athena/prompts";

const brand: BrandContext = {
  business_name: "Athena",
  business_description: "An SAT prep platform that teaches like a personal tutor.",
  audience: "Parents of high-schoolers",
  voice: "Warm, encouraging, plain-spoken",
  avoid: "AI-powered, dashboards, analytics",
  proof_points: [],
  standing: [],
  colors: [],
  fonts: [],
  visual_notes: "",
};

const cats = [
  { key: "MYTH", style_guide: "Bold headline over a flat illustration.", output_format: "myth, scene, insight line", images_per_carousel: 3, post_type: "narrative" as const, caption_guide: "", buffer_channel_service: "" },
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
    const empty: BrandContext = { business_name: "", business_description: "", audience: "", voice: "", avoid: "", proof_points: [], standing: [], colors: [], fonts: [], visual_notes: "" };
    const p = buildIdeaSystemPrompt(empty, [{ key: "X", style_guide: "", output_format: "", images_per_carousel: 1, post_type: "narrative" as const, caption_guide: "", buffer_channel_service: "" }]);
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
    proof_points: [] as string[], standing: [] as string[],
    colors: [] as string[], fonts: [] as string[], visual_notes: "",
  };
  const cats = [{ key: "SAT_MYTH", style_guide: "GUIDE", output_format: "", images_per_carousel: 5, post_type: "narrative" as const, caption_guide: "", buffer_channel_service: "" }];

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
    proof_points: [] as string[], standing: [] as string[],
    colors: [] as string[], fonts: [] as string[], visual_notes: "",
  };
  const cat = (post_type: "independent" | "narrative") => [{
    key: "SAT_MYTH", style_guide: "GUIDE", output_format: "",
    images_per_carousel: 5, post_type,
    caption_guide: "", buffer_channel_service: "",
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
      { key: "BEAGLE", style_guide: "G2", output_format: "", images_per_carousel: 5, post_type: "narrative" as const, caption_guide: "", buffer_channel_service: "" },
    ]);
    expect(p).toContain("For an INDEPENDENT category");
    expect(p).toContain("For a NARRATIVE category");
  });

  it("describes concept in type-neutral terms, not as a carousel's story", () => {
    const p = buildIdeaSystemPrompt(brand, cat("independent"));
    expect(p.toLowerCase()).not.toContain("summary of the story this carousel tells");
    expect(p).toContain("summary of the post this idea becomes");
  });

  it("scopes the structural-variety instruction to narrative carousels, not independent batches", () => {
    const p = buildIdeaSystemPrompt(brand, cat("independent"));
    // The instruction survives (it still applies whenever a narrative
    // category is in the batch), but it must name narrative carousels
    // rather than reading as a blanket rule over every idea in the batch.
    expect(p).toContain("Across the NARRATIVE carousels in this batch, vary the STRUCTURE");
  });
});

describe("buildIdeaSystemPrompt — post copy", () => {
  const copyCat = {
    key: "TL", style_guide: "G", output_format: "", images_per_carousel: 5,
    post_type: "narrative" as const,
    caption_guide: "First person, contrarian, end with a question.",
    buffer_channel_service: "linkedin",
  };
  const staticCat = {
    key: "MEME", style_guide: "G2", output_format: "", images_per_carousel: 1,
    post_type: "independent" as const, caption_guide: "", buffer_channel_service: "instagram",
  };

  it("adds a copy section only for categories with a caption_guide", () => {
    const p = buildIdeaSystemPrompt(brand, [copyCat, staticCat]);
    expect(p).toContain("POST COPY for TL");
    expect(p).not.toContain("POST COPY for MEME");
  });

  it("tells static categories to leave post_text empty", () => {
    const p = buildIdeaSystemPrompt(brand, [copyCat, staticCat]);
    expect(p).toContain('post_text must be the empty string ""');
  });

  it("stacks preset, then guide as the override", () => {
    const p = buildIdeaSystemPrompt(brand, [copyCat]);
    const preset = p.indexOf("thought leadership");
    const guide = p.indexOf("First person, contrarian, end with a question.");
    expect(preset).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(preset);
    expect(p).toContain("guide wins");
  });

  it("emits no copy instructions at all when no category has a guide", () => {
    const p = buildIdeaSystemPrompt(brand, [staticCat]);
    expect(p).not.toContain("POST COPY");
  });
});

describe("clampIdeaCount", () => {
  it("clamps a copy-mode batch requesting more than the cap", () => {
    expect(clampIdeaCount(20, true)).toBe(12);
  });
  it("clamps a copy-mode batch requesting just above the cap", () => {
    expect(clampIdeaCount(13, true)).toBe(12);
  });
  it("passes through a copy-mode batch already at or under the cap", () => {
    expect(clampIdeaCount(12, true)).toBe(12);
    expect(clampIdeaCount(5, true)).toBe(5);
  });
  it("passes through any count when no category in the batch is copy-mode", () => {
    expect(clampIdeaCount(20, false)).toBe(20);
  });
});

describe("platformPresetFor", () => {
  it("maps linkedin, twitter/x, instagram, and unknown", () => {
    expect(platformPresetFor("linkedin")).toContain("thought leadership");
    expect(platformPresetFor("twitter")).toContain("280");
    expect(platformPresetFor("x")).toContain("280");
    expect(platformPresetFor("Instagram")).toContain("hashtags");
    expect(platformPresetFor("")).toContain("caption");
  });
});

describe("buildAdaptCaptionSystemPrompt", () => {
  const brand = {
    business_name: "Athena", business_description: "SAT prep",
    audience: "parents", voice: "warm", avoid: "AI jargon",
    proof_points: [] as string[], standing: [] as string[],
    colors: [] as string[], fonts: [] as string[], visual_notes: "",
  };
  it("carries the target platform's conventions", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "" }, "x");
    expect(p).toContain("280");
  });
  it("layers the category's copy guide over the platform preset", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "Always end with a question." }, "linkedin");
    const preset = p.indexOf("thought leadership");
    const guide = p.indexOf("Always end with a question.");
    expect(preset).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(preset);
  });
  it("injects the brand context", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "" }, "linkedin");
    expect(p).toContain("Athena");
    expect(p).toContain("parents");
  });
  it("instructs preserving the point rather than restating verbatim", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "" }, "x");
    expect(p.toLowerCase()).toContain("same point");
  });
  it("omits the guide section entirely when the category has none", () => {
    const p = buildAdaptCaptionSystemPrompt(brand, { caption_guide: "" }, "x");
    expect(p).not.toContain("COPY GUIDE");
  });
});

describe("brandBlock — material", () => {
  const base = {
    business_name: "Athena", business_description: "SAT prep",
    audience: "parents", voice: "warm", avoid: "AI jargon",
    proof_points: [] as string[], standing: [] as string[],
    colors: [] as string[], fonts: [] as string[], visual_notes: "",
  };

  it("is byte-identical to the pre-material output when both lists are empty", () => {
    expect(brandBlock(base)).toBe(
      [
        "Business: Athena",
        "What it is: SAT prep",
        "Primary audience: parents",
        "Voice / tone: warm",
        "Never lead with / avoid: AI jargon",
      ].join("\n"),
    );
  });

  it("still returns the no-profile fallback for a wholly empty brand", () => {
    expect(
      brandBlock({
        business_name: "", business_description: "", audience: "", voice: "", avoid: "",
        proof_points: [], standing: [], colors: [], fonts: [], visual_notes: "",
      }),
    ).toBe("(No brand profile set yet — keep it generic and on-topic.)");
  });

  it("lists proof points as material when present", () => {
    const p = brandBlock({ ...base, proof_points: ["5,000 students up 120+ pts", "Founded by a 1590 scorer"] });
    expect(p).toContain("5,000 students up 120+ pts");
    expect(p).toContain("Founded by a 1590 scorer");
    expect(p.toLowerCase()).toContain("material");
  });

  it("lists standing when present", () => {
    const p = brandBlock({ ...base, standing: ["test prep", "study habits"] });
    expect(p).toContain("test prep");
    expect(p).toContain("study habits");
  });
});

describe("buildBrandExtractSystemPrompt", () => {
  const p = buildBrandExtractSystemPrompt();
  it("asks for concrete material, not adjectives", () => {
    expect(p.toLowerCase()).toContain("specific");
    expect(p.toLowerCase()).toContain("numbers");
  });
  it("forbids inventing claims", () => {
    expect(p.toLowerCase()).toContain("never invent");
  });
  it("says an empty proof_points list is a valid answer", () => {
    expect(p).toContain("empty");
  });
  it("scopes standing to what the sources evidence", () => {
    expect(p.toLowerCase()).toContain("standing");
    expect(p.toLowerCase()).toContain("evidence");
  });
});

describe("brandBlock — visual identity", () => {
  const base = {
    business_name: "Athena", business_description: "SAT prep",
    audience: "parents", voice: "warm", avoid: "AI jargon",
    proof_points: [] as string[], standing: [] as string[],
    colors: [] as string[], fonts: [] as string[], visual_notes: "",
  };

  it("is byte-identical to the pre-visual output when all three are empty", () => {
    expect(brandBlock(base)).toBe(
      [
        "Business: Athena",
        "What it is: SAT prep",
        "Primary audience: parents",
        "Voice / tone: warm",
        "Never lead with / avoid: AI jargon",
      ].join("\n"),
    );
  });

  it("carries colors and fonts when set", () => {
    const p = brandBlock({ ...base, colors: ["#0f172a", "#f97316"], fonts: ["Inter"] });
    expect(p).toContain("#0f172a");
    expect(p).toContain("Inter");
  });

  it("says the visual identity is a default a post type may override", () => {
    const p = brandBlock({ ...base, colors: ["#0f172a"] });
    expect(p.toLowerCase()).toContain("override");
  });

  it("carries visual_notes alone", () => {
    expect(brandBlock({ ...base, visual_notes: "Photography, never illustration." }))
      .toContain("Photography, never illustration.");
  });
});

describe("buildBrandExtractSystemPrompt — design tokens", () => {
  const p = buildBrandExtractSystemPrompt();
  it("explains the candidates are unjudged", () => {
    expect(p.toLowerCase()).toContain("candidate");
  });
  it("forbids inventing a palette", () => {
    expect(p.toLowerCase()).toContain("do not invent");
  });
});
