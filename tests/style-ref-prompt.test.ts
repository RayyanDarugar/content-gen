import { describe, expect, it } from "vitest";
import { buildStyleRefPrompt } from "@/lib/athena/style-ref-prompt";
import type { BrandContext } from "@/lib/athena/prompts";

function brand(over: Partial<BrandContext> = {}): BrandContext {
  return {
    business_name: "Athena",
    business_description: "An SAT prep platform that teaches like a personal tutor.",
    audience: "Parents of high-schoolers",
    voice: "Warm, encouraging, plain-spoken",
    avoid: "",
    proof_points: [],
    standing: [],
    colors: [],
    fonts: [],
    visual_notes: "",
    ...over,
  };
}

describe("buildStyleRefPrompt", () => {
  it("cites the real palette when colors are known", () => {
    const out = buildStyleRefPrompt(brand({ colors: ["#112233", "#445566"] }));
    expect(out).toContain("#112233");
    expect(out).toContain("#445566");
  });

  it("cites the real type when fonts are known", () => {
    expect(buildStyleRefPrompt(brand({ fonts: ["Poppins"] }))).toContain("Poppins");
  });

  it("cites visual notes when present", () => {
    expect(buildStyleRefPrompt(brand({ visual_notes: "Rounded corners, playful icons" })))
      .toContain("Rounded corners, playful icons");
  });

  it("falls back to business fields when no design tokens exist", () => {
    const out = buildStyleRefPrompt(brand());
    expect(out).toContain("An SAT prep platform");
    expect(out).toContain("Warm, encouraging, plain-spoken");
    expect(out).toContain("Parents of high-schoolers");
  });

  it("does not mention a palette line when no colors are known", () => {
    expect(buildStyleRefPrompt(brand())).not.toContain("Palette:");
  });

  it("always forbids logos and invented products, with or without design tokens", () => {
    expect(buildStyleRefPrompt(brand())).toContain("NO logo");
    expect(buildStyleRefPrompt(brand({ colors: ["#ffffff"] }))).toContain("NO logo");
  });

  it("appends regeneration notes when given, omits the line when not", () => {
    expect(buildStyleRefPrompt(brand(), "more muted, less saturated"))
      .toContain("more muted, less saturated");
    expect(buildStyleRefPrompt(brand())).not.toContain("Additional direction");
  });
});
