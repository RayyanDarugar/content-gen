import { NextResponse, type NextRequest } from "next/server";
import { createAnthropicClient } from "@/lib/anthropic";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { buildAdaptCaptionSystemPrompt } from "@/lib/athena/prompts";
import { loadBrandContext } from "@/lib/athena/brand-context";
import type { Category, Idea } from "@/lib/types";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const AdaptOutput = z.object({ text: z.string().describe("the adapted post copy, nothing else") });

export async function adaptCaptionForUser(
  userId: string,
  input: { categoryKey: string; baseText: string; service: string; ideaId: string | null },
): Promise<{ text: string }> {
  const supabase = createAdminSupabase();
  const { data: catData } = await supabase
    .from("categories").select("*").eq("key", input.categoryKey).eq("user_id", userId).maybeSingle();
  if (!catData) throw new Error("unknown category");
  const category = catData as Category;

  let idea: Idea | null = null;
  if (input.ideaId) {
    const { data } = await supabase.from("ideas").select("*").eq("id", input.ideaId).eq("user_id", userId).maybeSingle();
    idea = (data as Idea) ?? null;
  }

  const brand = await loadBrandContext(category.brand_id);

  const anthropic = createAnthropicClient({
    apiKey: await requireAnthropicKey(userId),
    feature: "post_caption_adapt",
  });
  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system: buildAdaptCaptionSystemPrompt(brand, category, input.service),
    messages: [{
      role: "user",
      content: [
        idea?.slides?.length
          ? `THE POST'S SLIDES (context — do not repeat their text verbatim):\n${JSON.stringify(idea.slides)}\n\n`
          : "",
        `ORIGINAL COPY:\n${input.baseText}`,
      ].join(""),
    }],
    output_config: { format: zodOutputFormat(AdaptOutput) },
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`adaptation returned no parseable output (stop_reason: ${response.stop_reason})`);
  return { text: parsed.text };
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryKey = body?.categoryKey;
  const baseText = body?.baseText;
  const service = body?.service;
  const ideaId = typeof body?.ideaId === "string" && body.ideaId ? body.ideaId : null;
  if (typeof categoryKey !== "string" || typeof baseText !== "string" || !baseText.trim() ||
      typeof service !== "string") {
    return NextResponse.json(
      { error: "expected { categoryKey: string, baseText: string, service: string, ideaId?: string }" },
      { status: 400 });
  }

  try {
    const result = await adaptCaptionForUser(user.id, { categoryKey, baseText, service, ideaId });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("caption adaptation failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
