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
  categories: { key: string; style_guide: string; output_format: string }[],
): string {
  const guides = categories
    .map((c) => {
      const parts = [`=== ${c.key} ===`];
      parts.push(c.style_guide || "[No style guide — fill in Config]");
      if (c.output_format) parts.push(`OUTPUT FORMAT: ${c.output_format}`);
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
  ideas: z.array(z.object({ category: z.string(), concept: z.string() })),
});
export type IdeasOutputT = z.infer<typeof IdeasOutput>;

export const FilterOutput = z.object({
  decisions: z.array(
    z.object({ idea_id: z.string(), keep: z.boolean(), reason: z.string() }),
  ),
});
export type FilterOutputT = z.infer<typeof FilterOutput>;
