import "server-only";

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_CHARS = 20_000;

// Hostname-level SSRF guard. This blocks literal private addresses and
// obvious loopback names; it does NOT resolve DNS, so a public hostname
// that resolves to a private address still gets through. That residual is
// accepted here: this endpoint is authenticated, the deployment is Vercel
// serverless (no metadata endpoint, no private service network), and the
// only output is text handed to an LLM.
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;      // IPv6 unique-local
  if (/^fe80:/i.test(host)) return true;                   // IPv6 link-local
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;               // link-local + metadata
  }
  return false;
}

export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Not a valid URL: ${raw.slice(0, 80)}`);
  }
  if (url.protocol !== "https:") throw new Error("Only https URLs can be read");
  if (isBlockedHost(url.hostname)) throw new Error("That host isn't reachable from here");
  return url;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
};

export function extractReadableText(html: string, maxChars = DEFAULT_MAX_CHARS): string {
  const stripped = html
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  const decoded = stripped
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ");
  return decoded.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

// Fetches a page's readable text with redirects validated per hop — the
// initial URL being https and public is not enough, since a redirect can
// otherwise land on http or a private address.
export async function fetchPageText(rawUrl: string): Promise<string> {
  let url = assertFetchableUrl(rawUrl);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(url, { redirect: "manual", headers: { accept: "text/html,text/plain" } });
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
  if (!res.ok) throw new Error(`Could not read that page (HTTP ${res.status})`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/")) {
    throw new Error(`That URL isn't a web page (${contentType.split(";")[0] || "unknown type"})`);
  }

  // Read incrementally and abort past the cap rather than buffering a
  // gigabyte first and checking afterwards.
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("That page is too large to read");
      }
      chunks.push(value);
    }
  }
  const html = new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const merged = new Uint8Array(acc.length + c.length);
      merged.set(acc);
      merged.set(c, acc.length);
      return merged;
    }, new Uint8Array()),
  );
  return extractReadableText(html);
}
