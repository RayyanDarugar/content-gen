import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  buildIdeaSystemPrompt, buildIdeaUserPrompt,
  FILTER_SYSTEM_PROMPT, IdeasOutput, FilterOutput,
} from "@/lib/athena/prompts";
import { applyFilterDecisions } from "@/lib/athena/filter";
import type { Category } from "@/lib/types";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

export async function generateIdeas(userId: string, categoryKey: string, count: number) {
  const supabase = createAdminSupabase();
  const anthropic = new Anthropic();

  let query = supabase.from("categories").select("*").eq("user_id", userId).eq("active", true);
  if (categoryKey !== "ALL") query = query.eq("key", categoryKey);
  const { data: categories, error: catErr } = await query;
  if (catErr) throw new Error(`categories query failed: ${catErr.message}`);
  if (!categories?.length) throw new Error(`no active categories for "${categoryKey}"`);
  const cats = categories as Category[];
  const activeKeys = cats.map((c) => c.key);

  // Call 1: generate ideas (structured output replaces the old JSON-repair parse)
  const genResponse = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: buildIdeaSystemPrompt(cats),
    messages: [{ role: "user", content: buildIdeaUserPrompt(count, activeKeys) }],
    output_config: { format: zodOutputFormat(IdeasOutput) },
  });
  const generated = genResponse.parsed_output;
  if (!generated) throw new Error(`idea generation returned no parseable output (stop_reason: ${genResponse.stop_reason})`);

  const raw = generated.ideas
    .filter((i) => activeKeys.includes(i.category))
    .map((i, idx) => ({ idea_id: `idea_${idx}`, category: i.category, concept: i.concept }));
  if (!raw.length) throw new Error("Claude returned zero usable ideas");

  // Call 2: self-filter
  const filterResponse = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system: FILTER_SYSTEM_PROMPT,
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
        ai_filter_reason: i.ai_filter_reason,
        approved: false,
        status: "pending_review",
        batch_id: batchId,
      })),
    );
    if (insErr) throw new Error(`insert failed: ${insErr.message}`);
  }
  return { inserted: kept.length, filteredOut: merged.length - kept.length, batchId };
}
