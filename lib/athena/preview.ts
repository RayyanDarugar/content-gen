import "server-only";
import { createAnthropicClient } from "@/lib/anthropic";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  buildIdeaSystemPrompt, buildIdeaUserPrompt, IdeasOutput, type BrandContext,
} from "@/lib/athena/prompts";
import { buildSlidePrompt } from "@/lib/athena/image-prompt";
import { uploadStyleRef, createKieTask } from "@/lib/athena/kie";
import { validateSlideShape } from "@/lib/athena/slides";
import { resolveRoleRef, roleRefUploadKey } from "@/lib/athena/role-refs";
import { requireAnthropicKey, requireKieKey } from "@/lib/settings/user-secrets";
import type { Category, Slide } from "@/lib/types";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const PREVIEW_IDEA_MAX_TOKENS = 4000; // one idea, max 10 slides

// Mirrors this codebase's other bounded-tolerance windows (e.g.
// MAX_CONSECUTIVE_POLL_ERRORS in the polling helper) — each attempt is a
// fresh, real generation call, so this is not unbounded retry. The batch
// idea-generation path (generate-ideas.ts) tolerates exactly this same class
// of occasional malformed slide shape by requesting many ideas and dropping
// the bad ones; a preview only ever wants one idea, so it retries instead.
const MAX_PREVIEW_ATTEMPTS = 3;

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
    proof_points: brandRow?.proof_points ?? [],
    standing: brandRow?.standing ?? [],
    colors: brandRow?.colors ?? [],
    fonts: brandRow?.fonts ?? [],
    visual_notes: brandRow?.visual_notes ?? "",
  };

  const anthropic = createAnthropicClient({
    apiKey: await requireAnthropicKey(userId),
    feature: "content_preview",
  });

  const expected = category.post_type === "narrative" ? category.images_per_carousel : 1;
  let lastReason = "no usable idea returned";
  for (let attempt = 1; attempt <= MAX_PREVIEW_ATTEMPTS; attempt++) {
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: PREVIEW_IDEA_MAX_TOKENS,
      system: buildIdeaSystemPrompt(brand, [category]),
      messages: [{ role: "user", content: buildIdeaUserPrompt(1, [category.key]) }],
      output_config: { format: zodOutputFormat(IdeasOutput) },
    });
    const idea = response.parsed_output?.ideas?.[0];
    if (!idea) {
      lastReason = "no usable idea returned";
      continue;
    }
    const slides = (idea.slides ?? []) as Slide[];
    const shape = validateSlideShape(slides, expected);
    if (shape.ok) return { concept: idea.concept, slides };
    console.warn(`preview idea attempt ${attempt}/${MAX_PREVIEW_ATTEMPTS} had the wrong shape: ${shape.reason}`);
    lastReason = shape.reason;
  }
  throw new Error(`preview idea had the wrong shape after ${MAX_PREVIEW_ATTEMPTS} attempts: ${lastReason}`);
}

export async function submitPreviewAnchor(
  userId: string,
  category: Category,
  slides: Slide[],
): Promise<{ styleUrl: string; taskId: string }> {
  const anchorRole = slides[0].role;
  const refUrl = resolveRoleRef(category, anchorRole);
  if (!refUrl) {
    throw new Error("Add a brand visual reference image first — the preview generates against it");
  }
  const kieKey = await requireKieKey(userId);
  const usedRoleRef = !!category.role_ref_urls?.[anchorRole];
  const styleUrl = await uploadStyleRef(
    kieKey, refUrl, userId, roleRefUploadKey(category.key, anchorRole, usedRoleRef));
  const { anchor } = buildPreviewPrompts(category, slides);
  const taskId = await createKieTask(kieKey, anchor, [styleUrl], category.aspect_ratio);
  return { styleUrl, taskId };
}

export async function submitPreviewFanout(
  userId: string,
  category: Category,
  slides: Slide[],
  // The anchor-role's already-uploaded ref, returned by submitPreviewAnchor.
  // Precedence per fanned slide mirrors resolveRoleRef: that slide's own
  // promoted role ref wins if one exists (uploaded fresh below, per-role
  // cached within this call); otherwise this param is the fallback — which
  // is itself already resolveRoleRef(category, anchorRole) resolved and
  // uploaded, not the raw style_ref_url.
  styleUrl: string,
  anchorImageUrl: string,
): Promise<{ taskIds: string[] }> {
  const kieKey = await requireKieKey(userId);
  const { fanout } = buildPreviewPrompts(category, slides);
  // If a fanned slide's role resolves to the exact same source url as the
  // anchor's (a role-less slide falling back to style_ref_url same as the
  // anchor, or a dedicated role ref that happens to be the same image), skip
  // uploading it again — styleUrl is already that image, already uploaded.
  const anchorResolvedUrl = resolveRoleRef(category, slides[0].role);
  const roleRefUrlCache = new Map<string, string>();
  const taskIds: string[] = [];
  for (let i = 0; i < fanout.length; i++) {
    const role = slides[i + 1].role;
    let refUrl = styleUrl;
    const resolved = resolveRoleRef(category, role);
    if (category.role_ref_urls?.[role] && resolved !== anchorResolvedUrl) {
      const cached = roleRefUrlCache.get(role);
      if (cached) {
        refUrl = cached;
      } else {
        refUrl = await uploadStyleRef(
          kieKey, resolved, userId, roleRefUploadKey(category.key, role, true));
        roleRefUrlCache.set(role, refUrl);
      }
    }
    taskIds.push(await createKieTask(kieKey, fanout[i], [refUrl, anchorImageUrl], category.aspect_ratio));
  }
  return { taskIds };
}
