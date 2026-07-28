import { z } from "zod";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { brandBlock, type BrandContext } from "@/lib/athena/prompts";
import type { Category, PostType, RoleGuides } from "@/lib/types";

// Every conversation turn returns this whole object — there is no free-text
// assistant output outside it. assistant_message renders in the chat; the
// rest renders in the live-draft panel and is upserted onto the category row.
// Deliberately absent: style_ref_url, post_caption, buffer_channel_id,
// active, key — the model never drafts those.
export const DraftTurnOutput = z.object({
  assistant_message: z.string().describe(
    "Short conversational reply: what changed, then the single most important open question",
  ),
  name: z.string().describe("Short human-readable category name"),
  style_guide: z.string().describe(
    "Everything EVERY panel shares — palette, subject, typography, layout, any persistent footer. Direct instructions to an image model.",
  ),
  output_format: z.string().describe("How ideas in this category are structured, one or two lines"),
  post_type: z.enum(["independent", "narrative"]),
  role_guides: z.object({
    hook: z.string().describe("Treatment belonging to the opening panel only — empty string if none"),
    beat: z.string().describe("Treatment belonging to middle panels only — empty string if none"),
    payoff: z.string().describe("Treatment belonging to the final panel only — empty string if none"),
    single: z.string().describe("Treatment for standalone images — empty string if none"),
  }),
  caption_guide: z.string().describe(
    "Copy instructions for the platform this category posts to — voice, structure, length, hashtags. Empty string if the category should keep static rotating captions instead of AI-written copy.",
  ),
  images_per_carousel: z.number().int().min(1).max(10),
  aspect_ratio: z.string().describe('Like "4:5" or "9:16"'),
});

export interface NormalizedDraft {
  name: string;
  style_guide: string;
  output_format: string;
  post_type: PostType;
  role_guides: RoleGuides;
  caption_guide: string;
  images_per_carousel: number;
  aspect_ratio: string;
}

// The client-held conversation state. Assistant turns carry the draft their
// turn produced, so the model can be shown its own prior full drafts.
export interface DraftTurn {
  role: "user" | "assistant";
  text: string;
  imageUrls?: string[]; // Cloudinary URLs attached to a user turn
  draft?: NormalizedDraft;
}

export function normalizeDraft(
  d: Omit<z.infer<typeof DraftTurnOutput>, "assistant_message">,
): NormalizedDraft {
  const role_guides: RoleGuides = {};
  for (const role of ["hook", "beat", "payoff", "single"] as const) {
    const v = d.role_guides[role]?.trim();
    if (v) role_guides[role] = v;
  }
  return {
    name: d.name.trim() || "Untitled draft",
    style_guide: d.style_guide,
    output_format: d.output_format,
    post_type: d.post_type,
    role_guides,
    caption_guide: d.caption_guide,
    // The DB check constraint (migration 0009) rejects narrative with < 2
    // slides, and JSON Schema can't express the conditional — clamp here.
    images_per_carousel:
      d.post_type === "narrative" ? Math.max(2, d.images_per_carousel) : d.images_per_carousel,
    aspect_ratio: d.aspect_ratio.trim() || "4:5",
  };
}

export function categoryToDraft(
  c: Pick<
    Category,
    "name" | "style_guide" | "output_format" | "post_type" | "role_guides" |
    "caption_guide" | "images_per_carousel" | "aspect_ratio"
  >,
): NormalizedDraft {
  return {
    name: c.name,
    style_guide: c.style_guide,
    output_format: c.output_format,
    post_type: c.post_type,
    role_guides: c.role_guides ?? {},
    caption_guide: c.caption_guide ?? "",
    images_per_carousel: c.images_per_carousel,
    aspect_ratio: c.aspect_ratio,
  };
}

export function buildDraftSystemPrompt(brand: BrandContext, seed?: NormalizedDraft): string {
  const lines = [
    "You are helping the owner of this business define a POST TYPE (a \"category\"): a reusable recipe their content engine uses to write and illustrate social posts.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    "You are having a short conversation. EVERY reply must contain the complete draft — every field, self-consistent, reflecting the whole conversation so far — plus assistant_message, a short conversational reply.",
    "In assistant_message: say what you changed, then ask about the single most important thing still unclear. One question at a time. Never restate the draft fields in assistant_message — they are displayed beside the chat already.",
    "",
    "FIELD RULES:",
    "- style_guide holds what EVERY panel shares: palette, subject or character, typography, layout, any persistent footer. Write it as direct instructions to an image model.",
    "- post_type is 'independent' when each image stands completely alone, 'narrative' when the slides tell ONE story (hook, beats, payoff).",
    "- role_guides holds ONLY treatment that belongs to a single role — a tag or strike-through on the hook, say. Anything named here must NOT also appear in style_guide: a per-panel element left in the style guide lands on every panel, including panels it must not. Use an empty string when a role needs nothing special.",
    "- caption_guide: how the post's published TEXT is written (voice, structure, length) for the platform it posts to. Leave it an empty string when static rotating captions are the right fit — e.g. simple image-first posts.",
    "- images_per_carousel: for narrative, the slide count of the story (2-10). For independent, how many standalone images one batch produces.",
    "- aspect_ratio: like \"4:5\" or \"9:16\".",
    "",
    "IF THE USER PROVIDES SCREENSHOTS OF A POST THEY LIKE:",
    "Extract ONLY structure and copy pattern from it: panel count, the job each panel does, pacing, how the text is worded.",
    "Multiple screenshots are the slides of ONE post, in order — read them as one sequential carousel, not separate posts.",
    "NEVER copy its colors, palette, fonts, photography style, or illustration style — this brand's visual identity comes from its own reference image, not from the example. Do not describe the screenshot's visual style in any field.",
  ];
  if (seed) {
    lines.push(
      "",
      "The user is revising an existing category. Its current fields:",
      JSON.stringify(seed, null, 2),
      "Change only what the conversation asks for; keep every other field verbatim.",
    );
  }
  return lines.join("\n");
}

export function toAnthropicMessages(turns: DraftTurn[]): MessageParam[] {
  return turns.map((t): MessageParam =>
    t.role === "assistant"
      ? { role: "assistant", content: JSON.stringify({ assistant_message: t.text, ...t.draft }) }
      : {
          role: "user",
          content: [
            ...(t.imageUrls ?? []).map((url) => ({
              type: "image" as const,
              source: { type: "url" as const, url },
            })),
            { type: "text" as const, text: t.text.trim() || "(no message — see attached image)" },
          ],
        },
  );
}
