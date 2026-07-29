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
    let designCandidates: DesignCandidates | null = null;
    if (url) {
      try {
        const { html, finalUrl } = await fetchPageHtml(url);
        pageText = extractReadableText(html);
        // Best-effort on top of best-effort: a hung, slow-redirecting, or
        // outright failing stylesheet fetch degrades design-token
        // extraction, never the whole brand extraction — pageText above
        // already succeeded and will still be sent to the model regardless
        // of what happens here. withDeadline resolves to the empty-sheets
        // fallback rather than rejecting on timeout or on any failure from
        // fetchStylesheets, so there is nothing here that can throw its way
        // into the outer catch and mislabel this as "couldn't read <url>".
        // The only remaining failure mode is parseDesignCandidates itself
        // throwing, which is guarded separately so it can never produce a
        // page-level warning for a page that was, in fact, read fine.
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

    // Documents ride as native attachments — Claude reads PDFs directly,
    // which matters because decks and one-pagers carry the proof points.
    // Each one is preflighted individually (HEAD/ranged-GET, classified by
    // its DECLARED content-type, never by file extension) so a dead link
    // or an unsupported type (a .docx, say) becomes a named warning
    // instead of taking the whole call down — documents are both the
    // richest proof-point source and the flakiest input, so isolation here
    // matters as much as it does for the URL fetch above.
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
    if (!content.length) {
      return NextResponse.json({ error: warnings[0] ?? "Nothing readable was provided." }, { status: 400 });
    }

    // A one-shot, user-initiated call the user is actively waiting on
    // (maxDuration = 120 above) — worth riding out a transient capacity
    // blip (529) with the SDK's own backoff rather than failing at the
    // default 2-retry budget (~5s). Do not "normalize" this back down.
    const anthropic = createAnthropicClient({
      apiKey: await requireAnthropicKey(user.id),
      feature: "brand_analysis",
      maxRetries: 5,
    });
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
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
