import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  buildIdeaSystemPrompt, buildIdeaUserPrompt, IdeasOutput, type BrandContext,
} from "@/lib/athena/prompts";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import { uploadStyleRef, createKieTask } from "@/lib/athena/kie";
import { validateSlideShape } from "@/lib/athena/slides";
import { requireAnthropicKey, requireKieKey } from "@/lib/settings/user-secrets";
import type { Category, Slide } from "@/lib/types";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const PREVIEW_IDEA_MAX_TOKENS = 4000; // one idea, max 10 slides

// Pure prompt assembly for a preview run: the same buildSlidePrompt calls
// production makes, minus every DB write. Anchor is unchained; slides 1..N
// are chained against [brand style ref, anchor image].
export function buildPreviewPrompts(
  category: Pick<Category, "style_guide" | "role_guides">,
  slides: Slide[],
): { anchor: string; fanout: string[] } {
  const total = slides.length;
  return {
    anchor: buildSlidePrompt(category.style_guide, slides[0], 1, total, false, "", category.role_guides),
    fanout: slides
      .slice(1)
      .map((s, i) => buildSlidePrompt(category.style_guide, s, i + 2, total, true, "", category.role_guides)),
  };
}

// One idea against this category, using the exact production prompt path —
// but never written to the ideas table. This is what "test this draft"
// generates against.
export async function generateSamplePreviewIdea(
  userId: string,
  category: Category,
): Promise<{ concept: string; slides: Slide[] }> {
  const supabase = createAdminSupabase();
  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").eq("user_id", userId).maybeSingle();
  const brand: BrandContext = {
    business_name: brandRow?.business_name ?? "",
    business_description: brandRow?.business_description ?? "",
    audience: brandRow?.audience ?? "",
    voice: brandRow?.voice ?? "",
    avoid: brandRow?.avoid ?? "",
  };

  const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(userId) });
  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: PREVIEW_IDEA_MAX_TOKENS,
    system: buildIdeaSystemPrompt(brand, [category]),
    messages: [{ role: "user", content: buildIdeaUserPrompt(1, [category.key]) }],
    output_config: { format: zodOutputFormat(IdeasOutput) },
  });
  const idea = response.parsed_output?.ideas?.[0];
  if (!idea) throw new Error("preview idea generation returned no usable idea");

  const expected = category.post_type === "narrative" ? category.images_per_carousel : 1;
  const slides = (idea.slides ?? []) as Slide[];
  const shape = validateSlideShape(slides, expected);
  if (!shape.ok) throw new Error(`preview idea had the wrong shape: ${shape.reason}`);
  return { concept: idea.concept, slides };
}

export async function submitPreviewAnchor(
  userId: string,
  category: Category,
  slides: Slide[],
): Promise<{ styleUrl: string; taskId: string }> {
  if (!category.style_ref_url) {
    throw new Error("Add a brand visual reference image first — the preview generates against it");
  }
  const kieKey = await requireKieKey(userId);
  const styleUrl = await uploadStyleRef(kieKey, category.style_ref_url, userId, category.key);
  const { anchor } = buildPreviewPrompts(category, slides);
  const taskId = await createKieTask(kieKey, anchor, [styleUrl], category.aspect_ratio);
  return { styleUrl, taskId };
}

export async function submitPreviewFanout(
  userId: string,
  category: Category,
  slides: Slide[],
  styleUrl: string,
  anchorImageUrl: string,
): Promise<{ taskIds: string[] }> {
  const kieKey = await requireKieKey(userId);
  const { fanout } = buildPreviewPrompts(category, slides);
  const taskIds: string[] = [];
  for (const prompt of fanout) {
    taskIds.push(await createKieTask(kieKey, prompt, [styleUrl, anchorImageUrl], category.aspect_ratio));
  }
  return { taskIds };
}
