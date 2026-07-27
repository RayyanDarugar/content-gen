import { z } from "zod";

export interface BrandContext {
  business_name: string;
  business_description: string;
  audience: string;
  voice: string;
  avoid: string;
}

function brandBlock(brand: BrandContext): string {
  const lines: string[] = [];
  if (brand.business_name) lines.push(`Business: ${brand.business_name}`);
  if (brand.business_description) lines.push(`What it is: ${brand.business_description}`);
  if (brand.audience) lines.push(`Primary audience: ${brand.audience}`);
  if (brand.voice) lines.push(`Voice / tone: ${brand.voice}`);
  if (brand.avoid) lines.push(`Never lead with / avoid: ${brand.avoid}`);
  return lines.length ? lines.join("\n") : "(No brand profile set yet — keep it generic and on-topic.)";
}

export function buildIdeaSystemPrompt(
  brand: BrandContext,
  categories: { key: string; style_guide: string; output_format: string; images_per_carousel: number }[],
): string {
  const guides = categories
    .map((c) => {
      const parts = [`=== ${c.key} ===`];
      parts.push(c.style_guide || "[No style guide — fill in Config]");
      if (c.output_format) parts.push(`OUTPUT FORMAT: ${c.output_format}`);
      parts.push(`REQUIRED SLIDE COUNT: ${c.images_per_carousel}`);
      return parts.join("\n");
    })
    .join("\n\n");

  return [
    "You are the creative content strategist for this business.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    "CATEGORY STYLE GUIDES (for context only — do NOT repeat these back in your output, they are stored separately):",
    guides,
    "",
    "CRITICAL INSTRUCTION FOR concept:",
    "Do NOT write a full image-generation prompt. Do NOT restate or summarize the style guide.",
    "Write only the specific creative content for this one idea — detailed enough that someone could generate the image from it later, but nothing about general style, palette, or layout (that already lives in the style guide).",
    "When a category specifies an OUTPUT FORMAT, follow it exactly for that category's ideas.",
    "",
    "CAROUSEL STRUCTURE — this is what you are writing:",
    "Each idea is a complete carousel with exactly the slide count listed for its category.",
    "When the count is greater than 1: exactly one 'hook' first, then 'beat' slides, then exactly one 'payoff' last.",
    "When the count is 1: a single slide with role 'single'.",
    "",
    "The panels must form ONE continuous story, not a set of separate observations:",
    "- Each beat must only make sense AFTER the one before it. If the panels could be reordered without loss, the carousel has failed.",
    "- The payoff must resolve the specific tension the hook opened — not a generic lesson.",
    "- 'text' is literally what appears on the image: one short phrase or sentence. No panel numbers, no labels, no captions about the panel.",
    "- 'visual' describes the scene, camera angle, and subject pose. Give every panel a different camera angle.",
    "- The story must be followable from the visuals alone.",
    "",
    "Across the batch, vary the STRUCTURE, not just the topic. Do not write every carousel to the same template or end every payoff with the same sentence shape — variety across the set matters as much as quality within one.",
  ].join("\n");
}

export function buildIdeaUserPrompt(count: number, activeKeys: string[]): string {
  return activeKeys.length === 1
    ? `Generate exactly ${count} content ideas for the ${activeKeys[0]} category.`
    : `Generate exactly ${count} content ideas distributed roughly evenly across: ${activeKeys.join(", ")}.`;
}

export function buildFilterSystemPrompt(brand: BrandContext): string {
  return [
    "You are a strict content quality reviewer for this business's social content. For each idea evaluate:",
    `1. Does it align with the brand? ${brandBlock(brand)}`,
    "2. Would it genuinely resonate with the target audience?",
    "3. Is it fresh and not a tired cliché?",
    "",
    "Return a decision for every idea, same idea_id values as the input.",
  ].join("\n");
}

export const IdeasOutput = z.object({
  ideas: z.array(z.object({
    category: z.string(),
    concept: z.string().describe("one-line summary of the story this carousel tells"),
    slides: z.array(z.object({
      role: z.enum(["hook", "beat", "payoff", "single"]),
      text: z.string().describe("the exact words appearing on this panel — short"),
      visual: z.string().describe("scene, camera angle, subject pose"),
    })),
  })),
});
export type IdeasOutputT = z.infer<typeof IdeasOutput>;

export const FilterOutput = z.object({
  decisions: z.array(
    z.object({ idea_id: z.string(), keep: z.boolean(), reason: z.string() }),
  ),
});
export type FilterOutputT = z.infer<typeof FilterOutput>;
