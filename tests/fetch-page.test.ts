import { describe, expect, it, vi } from "vitest";
import { isBlockedHost, assertFetchableUrl, extractReadableText } from "@/lib/fetch-page";

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
  it("handles script tags with embedded closing delimiter", () => {
    const out = extractReadableText(
      '<p>Safe</p><script>var x = "</script>"; alert(1);</script><p>Also safe</p>',
    );
    expect(out).not.toContain("alert");
    expect(out).not.toContain("injected");
    expect(out).toContain("Safe");
    expect(out).toContain("Also safe");
  });
  it("handles nested HTML comments correctly", () => {
    const out = extractReadableText("<!-- a <!-- b --> c --><p>Text</p>");
    expect(out).toContain("Text");
    expect(out).not.toContain("a");
    expect(out).not.toContain("b");
    expect(out).not.toContain("c");
  });
});
