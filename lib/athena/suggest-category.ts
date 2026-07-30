import { z } from "zod";
import { brandBlock, type BrandContext } from "@/lib/athena/prompts";
import { formatsBlock } from "@/lib/athena/formats";
import { validateSlideShape, type ShapeResult } from "@/lib/athena/slides";
import { DraftTurnOutput, type DraftTurn, type NormalizedDraft } from "@/lib/athena/draft-category";
import type { Format, Slide } from "@/lib/types";

// The model returns the whole proposal in one structured call: which format
// it used (or invented), why, a fully-worked sample post, and the post-type
// config itself. draft nests the wizard's existing schema verbatim so the
// result drops into the live panel with zero adaptation.
export const SuggestOutput = z.object({
  format_id: z.string().describe(
    "The exact id of the FORMAT LIBRARY entry this is built on. Empty string if you invented the structure yourself.",
  ),
  invented_format: z.object({
    name: z.string(),
    structure: z.string().describe("The reusable shape, independent of this brand"),
    why_it_works: z.string().describe("Why the structure works mechanically"),
    brand_fit: z.string().describe("What kind of brand can carry it"),
  }).describe(
    "The structure you invented, written so it could be reused by a different brand. Use empty strings for every field when format_id names a library entry.",
  ),
  rationale: z.string().describe(
    "Exactly two sentences. First: why this structure works mechanically. Second: why it fits THIS brand, naming a real proof point or standing entry.",
  ),
  sample: z.object({
    concept: z.string().describe("One-line summary of the sample post"),
    slides: z.array(z.object({
      role: z.enum(["hook", "beat", "payoff", "single"]),
      text: z.string().describe("The words that appear on the panel"),
      visual: z.string().describe("Scene, camera angle, subject pose"),
    })),
    caption: z.string().describe("The published caption for the sample post"),
  }),
  draft: DraftTurnOutput,
});

export interface SuggestedSample {
  concept: string;
  slides: Slide[];
  caption: string;
}

export interface SuggestResponse {
  suggestionId: string;
  formatId: string | null;
  rationale: string;
  draft: NormalizedDraft;
  sample: SuggestedSample;
}

export function buildSuggestSystemPrompt(
  brand: BrandContext,
  formats: Format[],
  excludeFormatIds: string[],
  excludeConcepts: string[],
): string {
  const lines = [
    "You are proposing a POST TYPE (a \"category\") for the owner of this business: a reusable recipe their content engine uses to write and illustrate social posts.",
    "",
    "BRAND CONTEXT:",
    brandBlock(brand),
    "",
    "Return ONE proposal: the post-type config, a fully-worked sample post using this brand's real material, and a two-sentence rationale.",
    "",
    "HONESTY RULES — these are absolute:",
    "- Do not claim anything is currently popular, trending, or working right now. Your knowledge has a cutoff and you cannot verify what is current.",
    "- Do not invent platform statistics, engagement numbers, or follower counts.",
    "- Do not name real accounts or creators as examples unless a library entry below names one, in which case you may cite that entry's source example and nothing more.",
    "- The rationale must be CRAFT plus FIT. Craft: why the structure works mechanically. Fit: why it suits THIS brand, naming a real proof point or standing entry from the brand context above.",
    "- The sample must use this brand's actual material. A sample built on invented claims is worse than no sample — it proves the system does not know them.",
  ];

  // The library section is a clean, appendable block: everything around it
  // — including the format_id/invented_format instruction below — stays
  // identical whether or not a library is supplied. That is what keeps an
  // empty-library prompt structurally identical to a no-library-concept one.
  const library = formatsBlock(formats, excludeFormatIds);
  if (library) {
    lines.push("", library);
  }

  lines.push(
    "",
    "If a library entry above genuinely fits this brand, set format_id to its id and leave every invented_format field an empty string. Otherwise, invent a structure yourself from your own knowledge of what makes social posts work: leave format_id an empty string and fill in invented_format so the structure could be reused by a different brand later.",
  );

  if (excludeConcepts.length) {
    lines.push("", "ALREADY SHOWN this session — propose something genuinely different, not a rephrasing:",
      ...excludeConcepts.map((c) => `- ${c}`));
  }

  lines.push("", "FIELD RULES for draft:",
    "- style_guide holds what EVERY panel shares: palette, subject or character, typography, layout, any persistent footer. Write it as direct instructions to an image model. Use the brand's own visual identity above as the default look.",
    "- post_type is 'independent' when each image stands completely alone, 'narrative' when the slides tell ONE story (hook, beats, payoff).",
    "- role_guides holds ONLY treatment belonging to a single role. Anything named there must NOT also appear in style_guide.",
    "- caption_guide: how the published TEXT is written. Empty string when static rotating captions fit better.",
    "- images_per_carousel: for narrative, the slide count of the story (2-10). For independent, how many standalone images one batch produces.",
    "",
    "The sample's slides must match draft.post_type: an independent post type gets EXACTLY ONE slide with role 'single'; a narrative one gets exactly images_per_carousel slides, opening with 'hook', closing with 'payoff', all middle slides 'beat'.",
  );

  return lines.join("\n");
}

export function validateSuggestedSample(
  sample: SuggestedSample,
  draft: NormalizedDraft,
): ShapeResult {
  // An independent post type's sample is one standalone image; there,
  // images_per_carousel means "how many per batch", not "slides in a story".
  const expected = draft.post_type === "independent" ? 1 : draft.images_per_carousel;
  return validateSlideShape(sample.slides, expected);
}

// Seeds the wizard conversation. Returns TWO turns, and the first is a user
// turn — the Anthropic API rejects a messages array beginning with an
// assistant turn, and the wizard replays this whole history on the next
// message, so an assistant-only seed would fail on turn 2 rather than turn 1.
// It is also just what happened: the user asked for a suggestion.
export function suggestionToTurns(res: SuggestResponse): DraftTurn[] {
  return [
    { role: "user", text: "Suggest a post type for my brand." },
    { role: "assistant", text: renderSuggestion(res), draft: res.draft },
  ];
}

function renderSuggestion(res: SuggestResponse): string {
  const { sample } = res;
  const slides = sample.slides.map(
    (s, i) => `${i + 1}. [${s.role}] ${s.text}${s.visual.trim() ? `\n   Visual: ${s.visual.trim()}` : ""}`,
  );
  return [
    res.rationale,
    "",
    `Here's how it would look — "${sample.concept}":`,
    ...slides,
    ...(sample.caption.trim() ? ["", `Caption: ${sample.caption.trim()}`] : []),
    "",
    "Want to change anything, or should we test it with real images?",
  ].join("\n");
}
