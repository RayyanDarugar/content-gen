import { describe, expect, it, vi } from "vitest";
import { isBlockedHost, assertFetchableUrl, extractReadableText, stylesheetHrefs } from "@/lib/fetch-page";

// Mock server-only for this test file only
vi.mock("server-only", () => ({}));

describe("isBlockedHost", () => {
  it("blocks loopback and localhost", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("127.1.2.3")).toBe(true);
    expect(isBlockedHost("::1")).toBe(true);
    expect(isBlockedHost("[::1]")).toBe(true);
  });
  it("blocks private IPv4 ranges", () => {
    expect(isBlockedHost("10.0.0.5")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
  });
  it("allows a public-looking 172 address outside the private block", () => {
    expect(isBlockedHost("172.32.0.1")).toBe(false);
    expect(isBlockedHost("172.15.0.1")).toBe(false);
  });
  it("blocks link-local and metadata addresses", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });
  it("blocks IPv6 unique-local", () => {
    expect(isBlockedHost("fd00::1")).toBe(true);
  });
  it("allows ordinary public hostnames", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("athena.study")).toBe(false);
  });
  it("blocks IPv4-mapped IPv6 loopback in dotted form", () => {
    expect(isBlockedHost("::ffff:127.0.0.1")).toBe(true);
  });
  it("blocks IPv4-mapped IPv6 metadata in dotted form", () => {
    expect(isBlockedHost("::ffff:169.254.169.254")).toBe(true);
  });
  it("blocks IPv4-mapped IPv6 private ranges in dotted form", () => {
    expect(isBlockedHost("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedHost("::ffff:192.168.1.1")).toBe(true);
  });
  it("blocks IPv4-mapped IPv6 in hex-normalized form", () => {
    expect(isBlockedHost("::ffff:7f00:1")).toBe(true);        // 127.0.0.1
    expect(isBlockedHost("::ffff:a9fe:a9fe")).toBe(true);    // 169.254.169.254
  });
  it("allows IPv4-mapped IPv6 public addresses", () => {
    expect(isBlockedHost("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("assertFetchableUrl", () => {
  it("accepts an https url", () => {
    expect(assertFetchableUrl("https://example.com/about").hostname).toBe("example.com");
  });
  it("rejects http", () => {
    expect(() => assertFetchableUrl("http://example.com")).toThrow(/https/i);
  });
  it("rejects a blocked host", () => {
    expect(() => assertFetchableUrl("https://127.0.0.1/")).toThrow();
  });
  it("rejects an unparseable url", () => {
    expect(() => assertFetchableUrl("not a url")).toThrow();
  });
});

describe("extractReadableText", () => {
  it("strips script and style content entirely", () => {
    const out = extractReadableText(
      "<html><head><style>.a{color:red}</style></head><body><script>alert(1)</script><p>Hello</p></body></html>",
    );
    expect(out).toContain("Hello");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("alert");
  });
  it("strips tags but keeps their text, separated", () => {
    expect(extractReadableText("<h1>Title</h1><p>Body</p>")).toBe("Title Body");
  });
  it("decodes common entities", () => {
    expect(extractReadableText("<p>Tom &amp; Jerry &mdash; &quot;hi&quot;</p>")).toContain("Tom & Jerry");
  });
  it("collapses whitespace", () => {
    expect(extractReadableText("<p>a\n\n   b</p>")).toBe("a b");
  });
  it("truncates to the cap", () => {
    expect(extractReadableText(`<p>${"x".repeat(500)}</p>`, 100)).toHaveLength(100);
  });
  it("handles unclosed script tags", () => {
    const out = extractReadableText("<p>Safe</p><script>alert('injected');");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("injected");
    expect(out).toContain("Safe");
  });
  it("handles script tags with embedded closing delimiter per HTML semantics", () => {
    // Per HTML spec, </script> ALWAYS ends a script element, even inside a string literal.
    // So <script>var x = "</script>" means the script ends there, and the rest becomes plain text.
    // The dangerous script tag is removed, but the text after becomes legitimate body content.
    const out = extractReadableText(
      '<p>Safe</p><script>var x = "</script>"; alert(1);</script><p>Also safe</p>',
    );
    // Script tag removed, but text after it is preserved as body content
    expect(out).toContain("Safe");
    expect(out).toContain("alert");  // This is now plain text, not in a script tag
    expect(out).toContain("Also safe");
  });
  it("ends a comment at the first --> per HTML spec (comments do not nest)", () => {
    // Per the HTML spec, a comment ends at the FIRST `-->` it encounters —
    // there is no such thing as a nested comment. So in
    // "<!-- a <!-- b --> c -->", the comment is exactly "<!-- a <!-- b -->"
    // and the trailing " c -->" is legitimate body text, not more comment.
    // A greedy match (from the first <!-- to the LAST --> in the document)
    // would swallow " c -->" too, and on a real page with multiple unrelated
    // comments it would swallow everything between them — the bug this test
    // guards against. Do not "fix" this back to greedy.
    const out = extractReadableText("<!-- a <!-- b --> c --><p>Text</p>");
    expect(out).toContain("Text");
    expect(out).toContain("c -->");
    expect(out).not.toContain("a");
    expect(out).not.toContain("b");
  });
  it("preserves body content between two separate HTML comments (regression test)", () => {
    // The greedy version of the comment-strip regex matched from the FIRST
    // <!-- to the LAST --> in the whole document, deleting everything in
    // between — including real body copy sitting between two ordinary,
    // unrelated comments (IE conditionals, framework markers, analytics
    // snippets). Almost every real page has at least two comments, so this
    // silently emptied extraction input. Guard against regressing to greedy.
    const out = extractReadableText(
      "<!-- header marker --><p>Real body copy</p><!-- footer marker -->",
    );
    expect(out).toContain("Real body copy");
    expect(out).not.toContain("header marker");
    expect(out).not.toContain("footer marker");
  });
  it("preserves body content between multiple script blocks (regression test)", () => {
    // Ensure non-greedy /g matching handles multiple script tags correctly.
    // With greedy matching, this would remove everything from first <script> to last </script>,
    // destroying the body content in between.
    const out = extractReadableText(
      '<script>analytics()</script><p>Important body</p><p>More content</p><script>bundle()</script>',
    );
    expect(out).toContain("Important body");
    expect(out).toContain("More content");
    expect(out).not.toContain("analytics");
    expect(out).not.toContain("bundle");
  });
  it("preserves body content between multiple style blocks (regression test)", () => {
    // Same for style tags.
    const out = extractReadableText(
      '<style>.a{color:red}</style><p>Content</p><p>More</p><style>.b{color:blue}</style>',
    );
    expect(out).toContain("Content");
    expect(out).toContain("More");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("color:blue");
  });
});

describe("stylesheetHrefs", () => {
  const base = "https://example.com/about/";
  it("resolves relative and absolute hrefs against the final url", () => {
    const html = `
      <link rel="stylesheet" href="/assets/app.css">
      <link rel="stylesheet" href="theme.css">
      <link rel="stylesheet" href="https://cdn.example.com/x.css">`;
    expect(stylesheetHrefs(html, base)).toEqual([
      "https://example.com/assets/app.css",
      "https://example.com/about/theme.css",
      "https://cdn.example.com/x.css",
    ]);
  });
  it("ignores non-stylesheet links", () => {
    const html = `<link rel="icon" href="/favicon.ico"><link rel="preconnect" href="https://fonts.gstatic.com">`;
    expect(stylesheetHrefs(html, base)).toEqual([]);
  });
  it("handles attribute order and extra rel tokens", () => {
    const html = `<link href="/a.css" rel="stylesheet"><link rel="preload stylesheet" href="/b.css">`;
    expect(stylesheetHrefs(html, base)).toContain("https://example.com/a.css");
    expect(stylesheetHrefs(html, base)).toContain("https://example.com/b.css");
  });
  it("caps at 3 and drops unparseable hrefs", () => {
    const html = ["/1.css", "/2.css", "/3.css", "/4.css"]
      .map((h) => `<link rel="stylesheet" href="${h}">`).join("") +
      `<link rel="stylesheet" href="::::">`;
    expect(stylesheetHrefs(html, base)).toHaveLength(3);
  });
});
