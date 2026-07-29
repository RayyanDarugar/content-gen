import { NextResponse, type NextRequest } from "next/server";
import { createAnthropicClient } from "@/lib/anthropic";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { buildAdaptCaptionSystemPrompt, type BrandContext } from "@/lib/athena/prompts";
import type { Category, Idea } from "@/lib/types";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const AdaptOutput = z.object({ text: z.string().describe("the adapted post copy, nothing else") });

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
    const supabase = await createServerSupabase();
    const { data: catData } = await supabase
      .from("categories").select("*").eq("key", categoryKey).maybeSingle();
    if (!catData) return NextResponse.json({ error: "unknown category" }, { status: 404 });
    const category = catData as Category;

    let idea: Idea | null = null;
    if (ideaId) {
      const { data } = await supabase.from("ideas").select("*").eq("id", ideaId).maybeSingle();
      idea = (data as Idea) ?? null;
    }

    const { data: brandRow } = await supabase
      .from("brand_profiles").select("*").eq("user_id", user.id).maybeSingle();
    const brand: BrandContext = {
      business_name: brandRow?.business_name ?? "",
      business_description: brandRow?.business_description ?? "",
      audience: brandRow?.audience ?? "",
      voice: brandRow?.voice ?? "",
      avoid: brandRow?.avoid ?? "",
      proof_points: brandRow?.proof_points ?? [],
      standing: brandRow?.standing ?? [],
    };

    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "post_caption_adapt",
    });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system: buildAdaptCaptionSystemPrompt(brand, category, service),
      messages: [{
        role: "user",
        content: [
          idea?.slides?.length
            ? `THE POST'S SLIDES (context — do not repeat their text verbatim):\n${JSON.stringify(idea.slides)}\n\n`
            : "",
          `ORIGINAL COPY:\n${baseText}`,
        ].join(""),
      }],
      output_config: { format: zodOutputFormat(AdaptOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) throw new Error(`adaptation returned no parseable output (stop_reason: ${response.stop_reason})`);
    return NextResponse.json({ text: parsed.text });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("caption adaptation failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
