// The callback redirects to `next` while holding a freshly minted session, so
// an open redirect here would hand an attacker an authenticated user on their
// own domain. Only same-origin relative paths are allowed: "//evil.test" is a
// protocol-relative URL, not a path, which is why one leading slash is not
// enough on its own.
export function safeNextPath(next: string | null): string {
  if (!next) return "/ideas";
  if (!next.startsWith("/")) return "/ideas";
  if (next.startsWith("//")) return "/ideas";
  return next;
}
