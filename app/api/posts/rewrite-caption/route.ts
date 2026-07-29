import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { brandBlock, platformPresetFor, type BrandContext } from "@/lib/athena/prompts";
import type { Category, Idea } from "@/lib/types";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const RewriteOutput = z.object({ text: z.string().describe("the rewritten post copy, nothing else") });

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryKey = body?.categoryKey;
  const note = body?.note;
  const currentText = typeof body?.currentText === "string" ? body.currentText : "";
  const ideaId = typeof body?.ideaId === "string" && body.ideaId ? body.ideaId : null;
  const imageUrls: string[] = Array.isArray(body?.imageUrls)
    ? body.imageUrls.filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://")).slice(0, 10)
    : [];
  if (typeof categoryKey !== "string" || typeof note !== "string" || !note.trim()) {
    return NextResponse.json(
      { error: "expected { categoryKey: string, note: string, imageUrls?: string[], ideaId?: string, currentText?: string }" },
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

    const system = [
      "You rewrite the published text of one social post. Return only the rewritten copy.",
      "",
      "BRAND CONTEXT:",
      brandBlock(brand),
      "",
      `PLATFORM: ${platformPresetFor(category.buffer_channel_service)}`,
      category.caption_guide.trim() ? `COPY GUIDE (wins over the platform note where they conflict):\n${category.caption_guide}` : "",
      idea?.slides?.length
        ? `THE POST'S SLIDES (for context — do not repeat their text verbatim):\n${JSON.stringify(idea.slides)}`
        : "",
      "The attached images are the post's actual visuals — the copy may reference what they show.",
    ].filter(Boolean).join("\n");

    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id) });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages: [{
        role: "user",
        content: [
          ...imageUrls.map((url) => ({ type: "image" as const, source: { type: "url" as const, url } })),
          {
            type: "text" as const,
            text: `CURRENT COPY:\n${currentText || "(none yet)"}\n\nREWRITE INSTRUCTION:\n${note}`,
          },
        ],
      }],
      output_config: { format: zodOutputFormat(RewriteOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) throw new Error(`rewrite returned no parseable output (stop_reason: ${response.stop_reason})`);
    return NextResponse.json({ text: parsed.text });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("caption rewrite failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
