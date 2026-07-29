import "server-only";

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

// HEAD-check a document URL to learn its content-type before committing it
// to the model call. Falls back to a ranged GET when HEAD isn't honored —
// some hosts 405 on HEAD or omit content-type from it — since we need the
// declared type to route the block kind correctly (see
// classifyDocumentContentType). Throws on network failure or a non-2xx
// response; callers are expected to catch per-document so one bad link
// can't take out the others.
export async function preflightDocument(url: string): Promise<DocumentPreflightResult> {
  let res = await fetch(url, { method: "HEAD" });
  if (!res.ok || !res.headers.get("content-type")) {
    res = await fetch(url, { method: "GET", headers: { range: "bytes=0-0" } });
  }
  if (!res.ok) throw new Error(`Could not read that document (HTTP ${res.status})`);
  const contentType = res.headers.get("content-type") ?? "";
  return { kind: classifyDocumentContentType(contentType), contentType };
}
