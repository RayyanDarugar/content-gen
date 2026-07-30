import { NextResponse, type NextRequest } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient } from "@/lib/anthropic";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { BrandExtractOutput, buildBrandExtractSystemPrompt } from "@/lib/athena/prompts";
import { fetchPageHtml, fetchStylesheets, extractReadableText } from "@/lib/fetch-page";
import { parseDesignCandidates, type DesignCandidates } from "@/lib/design-tokens";
import { preflightDocument } from "@/lib/document-preflight";
import { friendlyLlmError } from "@/lib/llm-errors";
import { withDeadline } from "@/lib/with-deadline";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

// The page fetch (fetchPageHtml) already costs up to (MAX_REDIRECTS + 1)
// hops * FETCH_TIMEOUT_MS = 4 * 10s = 40s worst case before design-token
// work even starts. Document preflights (preflightDocument, see
// lib/document-preflight.ts) can themselves cost up to 2 *
// (MAX_REDIRECTS + 1) * PREFLIGHT_TIMEOUT_MS = 2 * 4 * 5s = 40s worst case
// per document — a HEAD walk, then a ranged-GET walk when the HEAD is
// non-ok or omits content-type — and Promise.all across documents bounds
// that phase at one document's worst case, not the sum, but it's still 40s,
// not 20s. So pre-task this route already spent up to 40 (page) + 40
// (preflights) = 80s of its 120s maxDuration ahead of the Anthropic call,
// leaving 40s of headroom for a maxRetries: 5 call to ride out a capacity
// blip. Design tokens are the most expendable input here — the run is
// required to succeed on website text plus documents alone — so on a slow
// host they should be the thing that yields, not the thing that eats
// that headroom. DESIGN_TOKEN_BUDGET_MS is kept short enough that even its
// full worst case only takes this route to 85s (35s of headroom, 5s less
// than pre-task), while still giving a same-origin, non-redirecting
// stylesheet fetch — the common case — a real chance to land before it
// gives up and falls back to parsing design candidates from the page's own
// markup and inline <style> blocks alone.
const DESIGN_TOKEN_BUDGET_MS = 5_000;

export async function extractBrandProfileForUser(
  userId: string,
  input: { url: string | null; documentUrls: string[]; turns: { role: "user" | "assistant"; text: string }[] },
): Promise<Record<string, unknown> & { warnings: string[] }> {
  const { url, documentUrls, turns } = input;
  const warnings: string[] = [];
  let pageText = "";
  let designCandidates: DesignCandidates | null = null;
  if (url) {
    try {
      const { html, finalUrl } = await fetchPageHtml(url);
      pageText = extractReadableText(html);
      try {
        const sheets = await withDeadline(fetchStylesheets(html, finalUrl), DESIGN_TOKEN_BUDGET_MS, [] as string[]);
        designCandidates = parseDesignCandidates(html, sheets);
      } catch {
        designCandidates = null;
      }
    } catch (e) {
      warnings.push(`Couldn't read ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const documentBlocks: Anthropic.ContentBlockParam[] = [];
  const preflights = await Promise.all(
    documentUrls.map(async (u) => {
      try {
        return { url: u, ...(await preflightDocument(u)), error: null as string | null };
      } catch (e) {
        return { url: u, kind: null, contentType: "", error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  for (const p of preflights) {
    if (p.error) {
      warnings.push(`Couldn't read ${p.url}: ${p.error}`);
    } else if (p.kind === "document") {
      documentBlocks.push({ type: "document", source: { type: "url", url: p.url } });
    } else if (p.kind === "image") {
      documentBlocks.push({ type: "image", source: { type: "url", url: p.url } });
    } else {
      warnings.push(`Couldn't read ${p.url}: unsupported type (${p.contentType || "unknown"})`);
    }
  }

  const content: Anthropic.ContentBlockParam[] = [
    ...documentBlocks,
    ...(designCandidates && (designCandidates.colors.length || designCandidates.fonts.length)
      ? [{ type: "text" as const, text: `DESIGN CANDIDATES (unjudged, ranked):\n${JSON.stringify(designCandidates)}` }]
      : []),
    ...(pageText ? [{ type: "text" as const, text: `WEBSITE TEXT (${url}):\n${pageText}` }] : []),
    ...(turns.length
      ? [{ type: "text" as const, text: `WHAT THE USER TOLD YOU:\n${turns.map((t) => `${t.role}: ${t.text}`).join("\n")}` }]
      : []),
  ];
  if (!content.length) throw new Error(warnings[0] ?? "Nothing readable was provided.");

  const anthropic = createAnthropicClient({ apiKey: await requireAnthropicKey(userId), feature: "brand_analysis", maxRetries: 5 });
  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: buildBrandExtractSystemPrompt(),
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(BrandExtractOutput) },
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`extraction returned no parseable output (stop_reason: ${response.stop_reason})`);
  return { ...parsed, warnings };
}

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
    return NextResponse.json({ error: "Give it something to read — a website, a document, or a description." }, { status: 400 });
  }
  try {
    const result = await extractBrandProfileForUser(user.id, { url, documentUrls, turns });
    return NextResponse.json(result);
  } catch (e) {
    console.error("brand extraction failed:", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
