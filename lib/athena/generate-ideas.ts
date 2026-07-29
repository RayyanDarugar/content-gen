import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  buildIdeaSystemPrompt, buildIdeaUserPrompt, clampIdeaCount,
  buildFilterSystemPrompt, IdeasOutput, FilterOutput,
  type BrandContext,
} from "@/lib/athena/prompts";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { applyFilterDecisions } from "@/lib/athena/filter";
import { validateSlideShape } from "@/lib/athena/slides";
import type { Category, Slide } from "@/lib/types";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

// anthropic.messages.parse() below is non-streaming. The SDK computes
// expectedTime = (60min * max_tokens) / 128000 and throws before making any
// request once that exceeds its 10-minute default timeout — i.e. for any
// max_tokens above 21333 (@anthropic-ai/sdk 0.112.4, client.js
// calculateNonstreamingTimeout). Bumping this back toward the full worst
// case (200 slides in one batch) crosses that ceiling and fails idea
// generation 100% of the time before any network call. If truncation shows
// up again, switch this call to messages.stream() rather than raising this
// constant past ~21000.
const IDEA_GENERATION_MAX_TOKENS = 16000;

export async function generateIdeas(userId: string, categoryKey: string, count: number) {
  const supabase = createAdminSupabase();
  const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(userId) });

  let query = supabase.from("categories").select("*").eq("user_id", userId).eq("active", true);
  if (categoryKey !== "ALL") query = query.eq("key", categoryKey);
  const { data: categories, error: catErr } = await query;
  if (catErr) throw new Error(`categories query failed: ${catErr.message}`);
  if (!categories?.length) throw new Error(`no active categories for "${categoryKey}"`);
  const cats = categories as Category[];
  const activeKeys = cats.map((c) => c.key);

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
  };

  // Call 1: generate ideas (structured output replaces the old JSON-repair parse)
  // Worst case: /generate allows count up to 20, and a category's
  // images_per_carousel can be configured up to 10 (app/(app)/config), so one
  // batch can carry 200 slides, each with its own role/text/visual plus JSON
  // structural overhead — roughly 5-10x what one line per idea cost before
  // this branch. 8000 was sized for the old one-line-per-idea output and
  // silently truncates a large carousel batch, which discards the whole paid
  // call ("returned no parseable output"). IDEA_GENERATION_MAX_TOKENS is
  // capped by the SDK's non-streaming ceiling — see its definition — so this
  // is roughly double the original budget rather than the full worst case.
  const anyCopyMode = cats.some((c) => c.caption_guide.trim());
  const effectiveCount = clampIdeaCount(count, anyCopyMode);
  const genResponse = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: IDEA_GENERATION_MAX_TOKENS,
    system: buildIdeaSystemPrompt(brand, cats),
    messages: [{ role: "user", content: buildIdeaUserPrompt(effectiveCount, activeKeys) }],
    output_config: { format: zodOutputFormat(IdeasOutput) },
  });
  const generated = genResponse.parsed_output;
  if (!generated) throw new Error(`idea generation returned no parseable output (stop_reason: ${genResponse.stop_reason})`);

  const catByKey = new Map(cats.map((c) => [c.key, c]));
  // A static category (no caption_guide) can never store stray post_text,
  // even if the model writes something into that field anyway.
  const copyModeKeys = new Set(cats.filter((c) => c.caption_guide.trim()).map((c) => c.key));
  let droppedForShape = 0;
  const raw = generated.ideas
    .filter((i) => activeKeys.includes(i.category))
    .filter((i) => {
      const cat = catByKey.get(i.category);
      // An independent category posts N standalone images, but each IDEA is
      // one of them — so the expected slide count is 1, not images_per_carousel.
      const expected =
        cat?.post_type === "narrative" ? (cat.images_per_carousel ?? 1) : 1;
      const shape = validateSlideShape((i.slides ?? []) as Slide[], expected);
      if (!shape.ok) {
        console.warn(`dropping malformed carousel (${i.category}): ${shape.reason}`);
        droppedForShape++;
      }
      return shape.ok;
    })
    .map((i, idx) => ({
      idea_id: `idea_${idx}`, category: i.category, concept: i.concept,
      slides: i.slides as Slide[],
      post_text: copyModeKeys.has(i.category) ? (i.post_text ?? "") : "",
    }));
  if (!raw.length) throw new Error("Claude returned zero usable ideas");

  // Call 2: self-filter
  const filterResponse = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system: buildFilterSystemPrompt(brand),
    messages: [{
      role: "user",
      content: "Review and filter these ideas:\n" + JSON.stringify(raw, null, 2),
    }],
    output_config: { format: zodOutputFormat(FilterOutput) },
  });
  const decisions = filterResponse.parsed_output?.decisions ?? [];
  const merged = applyFilterDecisions(raw, decisions);

  const kept = merged.filter((i) => i.ai_keep);
  const batchId = randomUUID();
  if (kept.length) {
    const { error: insErr } = await supabase.from("ideas").insert(
      kept.map((i) => ({
        user_id: userId,
        category_key: i.category,
        concept: i.concept,
        resolved_prompt: i.concept,
        slides: i.slides,
        post_text: i.post_text,
        ai_filter_reason: i.ai_filter_reason,
        approved: false,
        status: "pending_review",
        batch_id: batchId,
      })),
    );
    if (insErr) throw new Error(`insert failed: ${insErr.message}`);
  }
  return { inserted: kept.length, filteredOut: merged.length - kept.length + droppedForShape, batchId };
}
