import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { BrandExtractOutput, buildBrandExtractSystemPrompt } from "@/lib/athena/prompts";
import { fetchPageText } from "@/lib/fetch-page";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : null;
  const documentUrls: string[] = Array.isArray(body?.documentUrls)
    ? body.documentUrls.filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://")).slice(0, 5)
    : [];
  const turns: { role: "user" | "assistant"; text: string }[] = Array.isArray(body?.turns)
    ? body.turns.filter((t: unknown) => {
        const turn = t as { role?: unknown; text?: unknown };
        return (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string";
      })
    : [];
  if (!url && !documentUrls.length && !turns.length) {
    return NextResponse.json(
      { error: "Give it something to read — a website, a document, or a description." },
      { status: 400 },
    );
  }

  const warnings: string[] = [];
  try {
    let pageText = "";
    if (url) {
      try {
        pageText = await fetchPageText(url);
      } catch (e) {
        warnings.push(`Couldn't read ${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Documents ride as native attachments — Claude reads PDFs directly,
    // which matters because decks and one-pagers carry the proof points.
    // Anything else in documentUrls (e.g. a plain image) rides as an image
    // block; only .pdf gets the document block, since that's the only
    // format we've verified the model reads structurally.
    const documentBlocks: Anthropic.ContentBlockParam[] = documentUrls.map((u) =>
      u.toLowerCase().endsWith(".pdf")
        ? { type: "document" as const, source: { type: "url" as const, url: u } }
        : { type: "image" as const, source: { type: "url" as const, url: u } },
    );

    const content: Anthropic.ContentBlockParam[] = [
      ...documentBlocks,
      ...(pageText ? [{ type: "text" as const, text: `WEBSITE TEXT (${url}):\n${pageText}` }] : []),
      ...(turns.length
        ? [{ type: "text" as const, text: `WHAT THE USER TOLD YOU:\n${turns.map((t) => `${t.role}: ${t.text}`).join("\n")}` }]
        : []),
    ];
    if (!content.length) {
      return NextResponse.json({ error: warnings[0] ?? "Nothing readable was provided." }, { status: 400 });
    }

    const anthropic = new Anthropic({ apiKey: await requireAnthropicKey(user.id) });
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: buildBrandExtractSystemPrompt(),
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(BrandExtractOutput) },
    });
    const parsed = response.parsed_output;
    if (!parsed) throw new Error(`extraction returned no parseable output (stop_reason: ${response.stop_reason})`);
    return NextResponse.json({ ...parsed, warnings });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("brand extraction failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
