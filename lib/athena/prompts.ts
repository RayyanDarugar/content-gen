import { z } from "zod";
import type { PostType, Category } from "@/lib/types";

export interface BrandContext {
  business_name: string;
  business_description: string;
  audience: string;
  voice: string;
  avoid: string;
}

export function brandBlock(brand: BrandContext): string {
  const lines: string[] = [];
  if (brand.business_name) lines.push(`Business: ${brand.business_name}`);
  if (brand.business_description) lines.push(`What it is: ${brand.business_description}`);
  if (brand.audience) lines.push(`Primary audience: ${brand.audience}`);
  if (brand.voice) lines.push(`Voice / tone: ${brand.voice}`);
  if (brand.avoid) lines.push(`Never lead with / avoid: ${brand.avoid}`);
  return lines.length ? lines.join("\n") : "(No brand profile set yet — keep it generic and on-topic.)";
}

// Platform conventions, most general layer of the copy stack. Case-
// insensitive; Buffer's exact service string for X is unverified, so both
// "twitter" and "x" match. Unknown/empty service gets a generic preset.
export function platformPresetFor(service: string): string {
  switch (service.trim().toLowerCase()) {
    case "linkedin":
      return "LinkedIn long-form thought leadership: a scroll-stopping hook line first, short paragraphs with line breaks, a concrete takeaway, no hashtag spam (2-3 max, at the end, if any). Roughly 600-1300 characters.";
    case "twitter":
    case "x":
      return "X post: tight and punchy, under 280 characters, no hashtags unless the guide asks.";
    case "instagram":
      return "Instagram caption: one to three short lines, then a blank line, then relevant hashtags.";
    default:
      return "A short platform-neutral caption: one or two sentences that frame the post.";
  }
}

export function buildIdeaSystemPrompt(
  brand: BrandContext,
  categories: {
    key: string; style_guide: string; output_format: string;
    images_per_carousel: number; post_type: PostType;
    caption_guide: string; buffer_channel_service: string;
  }[],
): string {
  const guides = categories
    .map((c) => {
      const parts = [`=== ${c.key} ===`];
      parts.push(c.style_guide || "[No style guide — fill in Config]");
      if (c.output_format) parts.push(`OUTPUT FORMAT: ${c.output_format}`);
      parts.push(
        c.post_type === "narrative"
          ? `POST TYPE: narrative — ONE carousel of exactly ${c.images_per_carousel} slides telling one story.`
          : "POST TYPE: independent — each idea is ONE standalone image. Exactly 1 slide, role \"single\".",
      );
      return parts.join("\n");
    })
    .join("\n\n");

  const copyCats = categories.filter((c) => c.caption_guide.trim());
  const copyBlock = copyCats.length
    ? [
        "",
        "POST COPY (the 'post_text' field):",
        "Some categories below carry copy instructions. For THOSE categories only, also write post_text: the full text published alongside the images — it is the primary asset on text-first platforms, the images support it. Write it from the same conception as the slides, but never duplicate the slide text verbatim.",
        `For every other category, post_text must be the empty string "".`,
        "Layering, most general to most specific — where they conflict, the category's guide wins:",
        ...copyCats.map((c) =>
          [
            `POST COPY for ${c.key}:`,
            `Platform: ${platformPresetFor(c.buffer_channel_service)}`,
            `Guide: ${c.caption_guide}`,
          ].join("\n"),
        ),
      ]
    : [];

  return [
    "You are the creative content strategist for this business.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    "CATEGORY STYLE GUIDES (for context only — do NOT repeat these back in your output, they are stored separately):",
    guides,
    ...copyBlock,
    "",
    "CRITICAL INSTRUCTION FOR concept:",
    "'concept' is a ONE-LINE summary of the post this idea becomes — a label, not a prompt.",
    "Do NOT write image-generation detail into concept, and do NOT restate or summarize the style guide there.",
    "Scene, camera angle, and subject pose belong on each slide's 'visual' field, not in concept (general style, palette, and layout already live in the style guide, separate from both).",
    "When a category specifies an OUTPUT FORMAT, use it to shape the slides for that category's ideas — not the concept line.",
    "",
    "WHAT TO WRITE — depends on the category's POST TYPE:",
    "",
    "For an INDEPENDENT category: each idea is one standalone image that works completely on its own.",
    "Give it exactly one slide with role 'single'. There is no sequence, no opener, no closer — do not write one.",
    "Its 'text' is the words on that image and its 'visual' is the scene.",
    "",
    "For a NARRATIVE category: each idea is one carousel with exactly the slide count listed for it.",
    "Exactly one 'hook' first, then 'beat' slides, then exactly one 'payoff' last.",
    "",
    "The panels of a NARRATIVE carousel must form ONE continuous story, not a set of separate observations:",
    "- Each beat must only make sense AFTER the one before it. If the panels could be reordered without loss, the carousel has failed.",
    "- The payoff must resolve the specific tension the hook opened — not a generic lesson.",
    "- 'text' is literally what appears on the image: one short phrase or sentence. No panel numbers, no labels, no captions about the panel.",
    "- 'visual' describes the scene, camera angle, and subject pose. Give every panel a different camera angle.",
    "- The story must be followable from the visuals alone.",
    "- Across the NARRATIVE carousels in this batch, vary the STRUCTURE, not just the topic. Do not write every carousel to the same template or end every payoff with the same sentence shape — variety across the set matters as much as quality within one.",
  ].join("\n");
}

// Copy-mode ideas carry post_text (up to ~1300 chars each) on top of their
// slides, which pushes a full 20-idea batch past the non-streaming token
// ceiling (see IDEA_GENERATION_MAX_TOKENS in generate-ideas.ts). Clamp rather
// than truncate: a truncated batch discards the whole paid call.
const COPY_MODE_MAX_IDEAS = 12;

export function clampIdeaCount(count: number, anyCopyMode: boolean): number {
  return anyCopyMode ? Math.min(count, COPY_MODE_MAX_IDEAS) : count;
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
    concept: z.string().describe("one-line summary of the post this idea becomes"),
    post_text: z.string().describe(
      "full post copy for categories with copy instructions; the empty string for all others",
    ),
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

export function buildAdaptCaptionSystemPrompt(
  brand: BrandContext,
  category: Pick<Category, "caption_guide">,
  service: string,
): string {
  return [
    "You adapt one social post's copy for a different platform. Return only the adapted copy.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    `TARGET PLATFORM: ${platformPresetFor(service)}`,
    category.caption_guide.trim() ? `COPY GUIDE (wins over the platform note where they conflict):\n${category.caption_guide}` : "",
    "",
    "Make the same point the original makes — this is the same post going to another audience, not a new idea. Restructure freely for the target platform's conventions: its length, its hook style, its formatting. Never simply copy the original across.",
  ].filter(Boolean).join("\n");
}
