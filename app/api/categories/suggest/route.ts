import { NextResponse, type NextRequest } from "next/server";
import { createAnthropicClient } from "@/lib/anthropic";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { normalizeDraft } from "@/lib/athena/draft-category";
import {
  SuggestOutput, buildSuggestSystemPrompt, validateSuggestedSample,
  type SuggestResponse,
} from "@/lib/athena/suggest-category";
import type { BrandContext } from "@/lib/athena/prompts";
import type { Format } from "@/lib/types";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
// A draft object plus a worked sample post — larger than a draft turn, still
// far short of the 16k idea batches.
const SUGGEST_MAX_TOKENS = 6000;

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const excludeConcepts = stringArray(body?.excludeConcepts);
  const excludeFormatIds = stringArray(body?.excludeFormatIds);

  try {
    const supabase = await createServerSupabase();

    const { data: brandRow } = await supabase
      .from("brand_profiles").select("*").eq("user_id", user.id).maybeSingle();
    if (!brandRow?.business_name?.trim()) {
      return NextResponse.json(
        { error: "Add your business name in brand setup first — a suggestion needs something to build on." },
        { status: 400 });
    }
    const brand: BrandContext = {
      business_name: brandRow.business_name ?? "",
      business_description: brandRow.business_description ?? "",
      audience: brandRow.audience ?? "",
      voice: brandRow.voice ?? "",
      avoid: brandRow.avoid ?? "",
      proof_points: brandRow.proof_points ?? [],
      standing: brandRow.standing ?? [],
      colors: brandRow.colors ?? [],
      fonts: brandRow.fonts ?? [],
      visual_notes: brandRow.visual_notes ?? "",
    };

    // RLS already restricts this to shared rows plus the caller's own.
    const { data: formatRows } = await supabase
      .from("formats").select("*").eq("active", true);
    const formats = (formatRows ?? []) as Format[];

    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "category_suggest",
    });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: SUGGEST_MAX_TOKENS,
      system: buildSuggestSystemPrompt(brand, formats, excludeFormatIds, excludeConcepts),
      messages: [{ role: "user", content: "Suggest a post type for my brand." }],
      output_config: { format: zodOutputFormat(SuggestOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error(`suggestion returned no parseable output (stop_reason: ${response.stop_reason})`);
    }

    const { assistant_message: _ignored, ...draftFields } = parsed.draft;
    const draft = normalizeDraft(draftFields);
    const sample = parsed.sample;

    // A malformed sample is a failed suggestion, not something to render
    // half of — the user would be shown a broken example of their own brand.
    const shape = validateSuggestedSample(sample, draft);
    if (!shape.ok) {
      throw new Error(`suggested sample has the wrong shape: ${shape.reason}`);
    }

    // Only trust format_id if it names a format we actually showed the model;
    // a hallucinated id would create a dangling provenance link.
    const claimedId = parsed.format_id.trim();
    const formatId = formats.some((f) => f.id === claimedId) ? claimedId : null;

    const { data: logRow, error: logError } = await supabase
      .from("format_suggestions")
      .insert({
        user_id: user.id,
        format_id: formatId,
        concept: sample.concept,
        // Only meaningful when nothing from the library was used. Stored now
        // so writeback keeps what the model actually conceived.
        invented_format: formatId ? null : parsed.invented_format,
      })
      .select("id")
      .single();
    if (logError) throw new Error(logError.message);

    const payload: SuggestResponse = {
      suggestionId: logRow.id as string,
      formatId,
      rationale: parsed.rationale,
      draft,
      sample,
    };
    return NextResponse.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("suggestion failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
