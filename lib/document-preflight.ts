import "server-only";
import { assertFetchableUrl } from "@/lib/fetch-page";

const MAX_REDIRECTS = 3;

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
// including the ranged-GET fallback.
async function fetchValidated(rawUrl: string, init: RequestInit): Promise<Response> {
  let url = assertFetchableUrl(rawUrl);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(url, { ...init, redirect: "manual" });
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
  return res;
}

// HEAD-check a document URL to learn its content-type before committing it
// to the model call. Falls back to a ranged GET when HEAD isn't honored —
// some hosts 405 on HEAD or omit content-type from it — since we need the
// declared type to route the block kind correctly (see
// classifyDocumentContentType). Throws on an unfetchable URL (blocked host,
// non-https, unparseable), a network failure, or a non-2xx response;
// callers are expected to catch per-document so one bad link can't take
// out the others.
export async function preflightDocument(url: string): Promise<DocumentPreflightResult> {
  let res = await fetchValidated(url, { method: "HEAD" });
  if (!res.ok || !res.headers.get("content-type")) {
    res = await fetchValidated(url, { method: "GET", headers: { range: "bytes=0-0" } });
  }
  if (!res.ok) throw new Error(`Could not read that document (HTTP ${res.status})`);
  const contentType = res.headers.get("content-type") ?? "";
  return { kind: classifyDocumentContentType(contentType), contentType };
}
