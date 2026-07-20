import { z } from "zod";

export function buildIdeaSystemPrompt(
  categories: { key: string; style_guide: string }[],
): string {
  const guides = categories
    .map((c) => `=== ${c.key} ===\n${c.style_guide || "[No style guide — fill in Config]"}`)
    .join("\n\n");

  return [
    "You are the creative content strategist for Athena, an SAT prep platform.",
    "",
    "NON-NEGOTIABLE BRAND RULES:",
    "- Athena is a personalized TEACHER, never an AI product, dashboard, or analytics tool",
    "- Core outcome: Ohhhh... now I get it.",
    "- Mascot: A cute Beagle dog — curious, friendly, slightly goofy. The Beagle is the guide/student in content, never the product.",
    "- Primary audience: Parents aged 35-55 worried about SAT scores, college admissions, tutoring costs, their kid feeling stuck.",
    "- NEVER lead with: AI-powered, adaptive learning, algorithms, analytics, dashboards.",
    "",
    "CATEGORY STYLE GUIDES (for context only — do NOT repeat these back in your output, they are already stored separately):",
    guides,
    "",
    "CRITICAL INSTRUCTION FOR concept:",
    "Do NOT write a full image-generation prompt. Do NOT restate or summarize the style guide.",
    "Just write the specific creative content for this one idea — detailed enough that someone could generate the image from it later, but nothing about general style, palette, or layout (that already lives in the style guide).",
    "For multi-panel/carousel categories (COMIC, BEAGLE_EXPLAINS), write out each panel/beat in sequence, with the exact text/dialogue for each panel.",
    "For SAT_MYTH, include: the myth statement, the visual scene, and the insight line.",
    "For NOTES_APP, include the full note text verbatim.",
    "For BRAIN_TEASER, include the actual puzzle and its answer.",
  ].join("\n");
}

export function buildIdeaUserPrompt(count: number, activeKeys: string[]): string {
  return activeKeys.length === 1
    ? `Generate exactly ${count} content ideas for the ${activeKeys[0]} category.`
    : `Generate exactly ${count} content ideas distributed roughly evenly across: ${activeKeys.join(", ")}.`;
}

export const FILTER_SYSTEM_PROMPT = [
  "You are a strict content quality reviewer for Athena SAT prep content. For each idea evaluate:",
  "1. Does it align with the Athena brand — personalized teacher, not AI product?",
  "2. Would it genuinely resonate with parents of high-schoolers or students feeling stuck?",
  "3. Is it fresh and not a tired SAT prep cliche?",
  "",
  "Return a decision for every idea, same idea_id values as the input.",
].join("\n");

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
