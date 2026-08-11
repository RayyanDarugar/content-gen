// The callback redirects to `next` while holding a freshly minted session, so
// an open redirect here would hand an attacker an authenticated user on their
// own domain. Only same-origin relative paths are allowed.
//
// Validated against a sentinel origin using the SAME parser that will perform
// the redirect. String checks and WHATWG URL parsing disagree in ways that
// matter here: new URL() normalizes a leading backslash and strips embedded
// tab/CR/LF, so "/\evil.test" resolves off-origin despite starting with
// exactly one slash. Checking with the parser closes that gap by construction
// rather than by enumerating tricks.
const SENTINEL = "http://safe-next.invalid";

export function safeNextPath(next: string | null): string {
  if (!next) return "/ideas";
  if (!next.startsWith("/")) return "/ideas";
  try {
    const url = new URL(next, SENTINEL);
    if (url.origin !== SENTINEL) return "/ideas";
    // Return the canonical form, not the raw input.
    const canonical = `${url.pathname}${url.search}${url.hash}`;
    // The INPUT origin check above is not enough: url.pathname can itself be
    // protocol-relative ("/..//evil.test" canonicalizes to "//evil.test"),
    // and it is this returned string the callback re-parses against the real
    // origin. Validate what is returned, not just what came in.
    if (canonical.startsWith("//")) return "/ideas";
    return canonical;
  } catch {
    return "/ideas";
  }
}
