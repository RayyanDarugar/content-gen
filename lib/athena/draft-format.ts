import { z } from "zod";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export const FormatDraftOutput = z.object({
  name: z.string().describe("Short memorable name for the structure"),
  structure: z.string().describe(
    "The slide-by-slide shape: how many panels, what job each one does, in order",
  ),
  why_it_works: z.string().describe("Why this structure works mechanically, in one or two sentences"),
  source_example: z.string().describe(
    "What this was taken from, described only as far as it can be seen. Empty string if unknown.",
  ),
  brand_fit: z.string().describe("What kind of brand can carry this structure"),
});

// Deliberately brand-free. A format entry is the reusable shape — binding it
// to one brand at capture time is what would stop a different brand from
// using it, and would stop a scraper from feeding this same function later.
export function buildFormatDraftSystemPrompt(): string {
  return [
    "You are cataloguing a social post FORMAT: the reusable structure behind a post, written so a completely different brand could carry it.",
    "",
    "Extract ONLY structure and copy pattern: panel count, the job each panel does, pacing, how the text is worded.",
    "Multiple screenshots are the slides of ONE post, in order — read them as one sequential carousel, not as separate posts.",
    "",
    "NEVER record the example's colors, palette, fonts, photography style, or illustration style. Those belong to whoever made it. The structure is what transfers; the look does not.",
    "",
    "HONESTY RULES:",
    "- Do not invent engagement numbers, follower counts, or dates. You cannot see them.",
    "- Do not claim the format is currently popular or trending. You cannot verify that.",
    "- Describe source_example only as far as you can actually see it. An empty string is better than a guess.",
    "",
    "why_it_works must be mechanical — what the structure does to a reader's attention — not a claim about performance.",
  ].join("\n");
}

export function formatDraftMessages(screenshotUrls: string[], note: string): MessageParam[] {
  return [{
    role: "user",
    content: [
      ...screenshotUrls.map((url) => ({
        type: "image" as const,
        source: { type: "url" as const, url },
      })),
      {
        type: "text" as const,
        text: note.trim() || "Catalogue the format shown in these screenshots.",
      },
    ],
  }];
}
