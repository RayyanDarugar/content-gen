import "server-only";

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 10_000; // per-hop budget for a page fetch — generous for reading a body

// Check if a single IPv4 address (by first two octets) is in a blocked range.
// Shared by direct dotted notation and IPv6-mapped extraction.
function isBlockedIpv4(a: number, b: number): boolean {
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;               // link-local + metadata
  return false;
}

// Hostname-level SSRF guard. This blocks literal private addresses and
// obvious loopback names; it does NOT resolve DNS, so a public hostname
// that resolves to a private address still gets through. That residual is
// accepted here: the deployment is Vercel serverless (no metadata endpoint,
// no private service network), and the only output is text handed to an
// LLM. Note the trust model is broader than "an authenticated user chose
// this URL": stylesheet hrefs (see fetchStylesheets below) are read out of
// a third-party page's own markup, so an arbitrary remote page can name an
// arbitrary hostname here too — the residual (a public-looking hostname
// that resolves to a private address) is unchanged, but it's now reachable
// via attacker-supplied content, not only via an authenticated caller's
// input.
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;      // IPv6 unique-local
  if (/^fe80:/i.test(host)) return true;                   // IPv6 link-local

  // Check direct dotted-decimal IPv4
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return isBlockedIpv4(Number(v4[1]), Number(v4[2]));
  }

  // Check IPv4-mapped IPv6: ::ffff:x.x.x.x or ::ffff:xxxx:xxxx
  // The :: prefix matches any number of zero groups before ffff
  if (host.includes("ffff:")) {
    // Extract what comes after "ffff:"
    const match = host.match(/ffff:(.+)$/i);
    if (match) {
      const tail = match[1];
      // Tail could be dotted decimal (127.0.0.1) or hex groups (7f00:1)
      const dotted = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (dotted) {
        return isBlockedIpv4(Number(dotted[1]), Number(dotted[2]));
      }

      // Parse hex-group form: first group encodes first two octets
      // e.g., ::ffff:7f00:1 means 7f00 (127.0) and 0001 (0.1) → 127.0.0.1
      // or ::ffff:a9fe:a9fe means a9fe (169.254) → 169.254.*.*
      const hexGroups = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      if (hexGroups) {
        const high = parseInt(hexGroups[1], 16);
        const a = (high >> 8) & 0xff;
        const b = high & 0xff;
        return isBlockedIpv4(a, b);
      }
    }
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
  // Strip dangerous tags (script, style, noscript, svg, head) resiliently in two passes:
  // Pass 1: Remove well-formed pairs using non-greedy matching.
  //         Per HTML spec, </script> ends the element even if it appears in a string literal,
  //         so non-greedy matching correctly parses the content.
  // Pass 2: Remove any remaining unclosed opening tags and everything until EOF.
  let stripped = html;
  const tagNames = ["script", "style", "noscript", "svg", "head"];

  // Pass 1: Remove all well-formed pairs (handles nested/multiple tags correctly with /g)
  for (const tagName of tagNames) {
    stripped = stripped.replace(
      new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?</${tagName}\\b[^>]*>`, "gi"),
      " ",
    );
  }

  // Pass 2: Remove any remaining unclosed opening tags and content until EOF
  for (const tagName of tagNames) {
    stripped = stripped.replace(
      new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*`, "i"),
      " ",
    );
  }

  // Strip HTML comments with NON-greedy matching. Per the HTML spec, comments
  // do not nest — a comment ends at the first `-->` encountered, full stop.
  // A greedy match here (matching from the first `<!--` to the LAST `-->` in
  // the whole document) silently deletes every real element between two
  // ordinary, unrelated comments, which is virtually every page (IE
  // conditionals, framework markers, analytics snippets all add comments).
  // This is the same greedy-vs-non-greedy bug already fixed once above for
  // <script>/<style> — don't reintroduce it here.
  stripped = stripped.replace(/<!--[\s\S]*?-->/g, " ");

  // Strip remaining tags
  const tagless = stripped.replace(/<[^>]+>/g, " ");

  // Decode entities
  const decoded = tagless
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ");

  return decoded.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

// The raw fetch, shared so one page load can serve both readable text and
// design-token parsing, and so a stylesheet fetch can reuse the identical
// validation/redirect/timeout/size-cap path with only its Accept header
// varying (CSS is not html). `accept` is the one caller-controlled knob;
// every guard below applies unconditionally to both callers.
//
// Fetches with redirects validated per hop — the initial URL being https
// and public is not enough, since a redirect can otherwise land on http or
// a private address.
async function fetchValidated(rawUrl: string, accept: string): Promise<{ html: string; finalUrl: string }> {
  let url = assertFetchableUrl(rawUrl);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      // A fresh AbortSignal.timeout per hop, not one shared across the
      // whole redirect chain — a slow host shouldn't get to eat the full
      // budget on hop 1 and then stall forever on hop 2.
      res = await fetch(url, {
        redirect: "manual",
        headers: { accept },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error("That page took too long to respond");
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
  return { html, finalUrl: url.toString() };
}

// The raw page fetch, shared so one page load can serve both readable text
// and design-token parsing. fetchPageText is a thin wrapper over this — its
// behaviour is unchanged, and its tests are the proof.
export async function fetchPageHtml(rawUrl: string): Promise<{ html: string; finalUrl: string }> {
  return fetchValidated(rawUrl, "text/html,text/plain");
}

// Fetches a page's readable text. A thin wrapper over fetchPageHtml — kept
// as its own export so its signature and behaviour never change.
export async function fetchPageText(rawUrl: string): Promise<string> {
  const { html } = await fetchPageHtml(rawUrl);
  return extractReadableText(html);
}

const MAX_STYLESHEETS = 3;

// Finds <link rel="stylesheet"> hrefs in html and resolves them against
// baseUrl (the final URL reached after redirects, so relative hrefs land
// correctly). Non-greedy tag matching: <link> elements don't nest, and a
// greedy match across multiple tags would blur their boundaries.
export function stylesheetHrefs(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*?>/gi)) {
    const tag = m[0];
    const rel = tag.match(/rel\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    if (!/\bstylesheet\b/i.test(rel)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      out.push(new URL(href, baseUrl).toString());
    } catch {
      // An unparseable href is skipped, not fatal.
    }
    if (out.length === MAX_STYLESHEETS) break;
  }
  return out;
}

// CSS is served as text/css, not text/html — fetchPageHtml's Accept header
// would work against a lenient server but is semantically wrong and can 406
// against one doing strict content negotiation, which would silently empty
// out the design-token input with no error surfaced anywhere. Widened here,
// and only here: fetchPageText's Accept header (and its text/* content-type
// gate) is untouched.
const STYLESHEET_ACCEPT = "text/css,text/plain;q=0.5,*/*;q=0.1";

// Best-effort: a sheet that fails to load degrades the design-token
// result, it never fails the extraction run. Each goes through the same
// assertFetchableUrl/redirect/timeout/size-cap path as the page itself, via
// the shared fetchValidated — no second fetch helper.
//
// Fetched with Promise.all, not a sequential loop: MAX_STYLESHEETS caps the
// *count* at 3, but each fetch can still take up to (MAX_REDIRECTS + 1) *
// FETCH_TIMEOUT_MS on a chain of slow/stalling hops, and the whole point of
// the cap ("a site with a dozen bundles cannot stall extraction") is
// defeated if 3 worst-case sheets are summed serially on top of the page
// fetch's own worst case — that blew the route's maxDuration budget. Running
// them concurrently keeps the sheet phase bounded by one sheet's worst case,
// not three, while each individual fetch keeps its own per-hop timeouts.
export async function fetchStylesheets(html: string, baseUrl: string): Promise<string[]> {
  const results = await Promise.all(
    stylesheetHrefs(html, baseUrl).map(async (href) => {
      try {
        const { html: css } = await fetchValidated(href, STYLESHEET_ACCEPT);
        return css;
      } catch {
        return null; // skipped — a failed sheet degrades the result, never fails the run
      }
    }),
  );
  return results.filter((css): css is string => css !== null);
}
