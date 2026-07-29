import "server-only";
import { assertFetchableUrl } from "@/lib/fetch-page";

const MAX_REDIRECTS = 3;
// Preflight only ever reads headers (HEAD, or a 1-byte ranged GET), so a
// short budget is generous. Overridable per call — tests inject a much
// smaller one rather than waiting out the real default.
export const PREFLIGHT_TIMEOUT_MS = 5_000;

export type DocumentBlockKind = "document" | "image";

// Decide how a document should ride in a message from its DECLARED
// content-type, not its file extension. Extension guessing is unreliable —
// a Cloudinary link for a real PDF can come back as octet-stream, and a
// same-name upload can silently be a different type — so this trusts what
// the server actually reports. Returns null for anything unsupported
// (word docs, slide decks, unknown/missing types), which callers should
// route into warnings rather than guess at.
export function classifyDocumentContentType(
  contentType: string | null | undefined,
): DocumentBlockKind | null {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/pdf") return "document";
  if (type.startsWith("image/")) return "image";
  return null;
}

export interface DocumentPreflightResult {
  kind: DocumentBlockKind | null;
  contentType: string;
}

// Same SSRF guard fetchPageText uses, applied per hop: the starting URL
// being https and public is not enough, since a redirect (a Cloudinary
// link reshuffling to a signed asset host, say) can otherwise land
// somewhere private. Re-validates before every network call this makes,
// including the ranged-GET fallback. Returns the final URL reached
// alongside the response so a caller chaining a second request (the
// fallback GET) can resume from there instead of re-walking the same
// redirect chain from the top.
async function fetchValidated(
  rawUrl: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; url: URL }> {
  let url = assertFetchableUrl(rawUrl);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      // A fresh AbortSignal.timeout per hop, not one budget shared across
      // the whole chain — otherwise a slow host eats the budget on hop 1
      // and stalls forever on hop 2.
      res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error(`Timed out after ${timeoutMs}ms`);
      }
      throw e;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect with no location (HTTP ${res.status})`);
      url = assertFetchableUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!res) throw new Error("No response");
  if (res.status >= 300 && res.status < 400) throw new Error("Too many redirects");
  return { res, url };
}

// HEAD-check a document URL to learn its content-type before committing it
// to the model call. Falls back to a ranged GET when HEAD isn't honored —
// some hosts 405 on HEAD or omit content-type from it — since we need the
// declared type to route the block kind correctly (see
// classifyDocumentContentType). The fallback resumes from the URL the HEAD
// probe actually landed on rather than the original, so a redirecting host
// only gets its chain walked (and validated) once. Throws on an
// unfetchable URL (blocked host, non-https, unparseable), a timeout, a
// network failure, or a non-2xx response; callers are expected to catch
// per-document so one bad link can't take out the others.
export async function preflightDocument(
  url: string,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
): Promise<DocumentPreflightResult> {
  const head = await fetchValidated(url, { method: "HEAD" }, timeoutMs);
  let res = head.res;
  if (!res.ok || !res.headers.get("content-type")) {
    ({ res } = await fetchValidated(
      head.url.toString(),
      { method: "GET", headers: { range: "bytes=0-0" } },
      timeoutMs,
    ));
  }
  if (!res.ok) throw new Error(`Could not read that document (HTTP ${res.status})`);
  const contentType = res.headers.get("content-type") ?? "";
  // Only headers are ever read here — the ranged-GET fallback still gets a
  // body (even if just the requested 1 byte, or the whole thing if a host
  // ignores Range), which is otherwise never consumed or canceled, leaving
  // the connection lingering. Cancel it explicitly; swallow any error since
  // a failed cancel shouldn't fail a preflight that already has what it needs.
  await res.body?.cancel().catch(() => {});
  return { kind: classifyDocumentContentType(contentType), contentType };
}
