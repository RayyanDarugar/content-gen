import { NextResponse, type NextRequest } from "next/server";
import { createAnthropicClient } from "@/lib/anthropic";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import {
  FormatDraftOutput, buildFormatDraftSystemPrompt, formatDraftMessages,
} from "@/lib/athena/draft-format";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const FORMAT_DRAFT_MAX_TOKENS = 2000;

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const screenshotUrls = Array.isArray(body?.screenshotUrls)
    ? body.screenshotUrls.filter((u: unknown): u is string => typeof u === "string")
    : [];
  const note = typeof body?.note === "string" ? body.note : "";

  if (!screenshotUrls.length && !note.trim()) {
    return NextResponse.json(
      { error: "Add a screenshot or describe the format first" }, { status: 400 });
  }

  try {
    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "format_draft",
    });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: FORMAT_DRAFT_MAX_TOKENS,
      system: buildFormatDraftSystemPrompt(),
      messages: formatDraftMessages(screenshotUrls, note),
      output_config: { format: zodOutputFormat(FormatDraftOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error(`format draft returned no parseable output (stop_reason: ${response.stop_reason})`);
    }
    return NextResponse.json({ draft: parsed });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("format draft failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
