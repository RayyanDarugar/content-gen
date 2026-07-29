import { describe, expect, it, vi, afterEach } from "vitest";

// Mock server-only for this test file only
vi.mock("server-only", () => ({}));

import { classifyDocumentContentType, preflightDocument } from "@/lib/document-preflight";

describe("classifyDocumentContentType", () => {
  it("classifies a PDF as a document block", () => {
    expect(classifyDocumentContentType("application/pdf")).toBe("document");
  });
  it("classifies an image type as an image block", () => {
    expect(classifyDocumentContentType("image/png")).toBe("image");
    expect(classifyDocumentContentType("image/jpeg")).toBe("image");
  });
  it("treats an unsupported office type as unsupported", () => {
    expect(
      classifyDocumentContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBeNull();
  });
  it("treats a missing or empty content-type as unsupported", () => {
    expect(classifyDocumentContentType(null)).toBeNull();
    expect(classifyDocumentContentType(undefined)).toBeNull();
    expect(classifyDocumentContentType("")).toBeNull();
  });
  it("ignores charset/boundary parameters when matching", () => {
    expect(classifyDocumentContentType("application/pdf; charset=binary")).toBe("document");
    expect(classifyDocumentContentType("image/png; charset=binary")).toBe("image");
  });
});

describe("preflightDocument", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("classifies from a successful HEAD response", async () => {
    global.fetch = vi.fn(async () =>
      new Response(null, { status: 200, headers: { "content-type": "application/pdf" } }),
    ) as unknown as typeof fetch;
    const result = await preflightDocument("https://example.com/deck.pdf");
    expect(result.kind).toBe("document");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to a ranged GET when HEAD has no content-type", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 206, headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const result = await preflightDocument("https://example.com/asset");
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(result.kind).toBe("image");
  });

  it("falls back to GET when HEAD itself is rejected", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "HEAD") {
        return new Response(null, { status: 405 });
      }
      return new Response(null, { status: 200, headers: { "content-type": "application/pdf" } });
    }) as unknown as typeof fetch;
    const result = await preflightDocument("https://example.com/report");
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(result.kind).toBe("document");
  });

  it("throws on a non-2xx response after the fallback", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(preflightDocument("https://example.com/missing.pdf")).rejects.toThrow(/404/);
  });

  it("rejects a private/loopback document URL without making any network call", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    await expect(preflightDocument("https://[::ffff:127.0.0.1]/x.pdf")).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still classifies an ordinary https URL normally", async () => {
    global.fetch = vi.fn(async () =>
      new Response(null, { status: 200, headers: { "content-type": "application/pdf" } }),
    ) as unknown as typeof fetch;
    const result = await preflightDocument("https://example.com/one-pager.pdf");
    expect(result.kind).toBe("document");
  });

  it("re-validates a redirect hop and rejects one that lands on a blocked host", async () => {
    global.fetch = vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/internal.pdf" },
        });
      }
      throw new Error("should not reach a second request past the rejected redirect");
    }) as unknown as typeof fetch;
    await expect(preflightDocument("https://cdn.example.com/deck.pdf")).rejects.toThrow();
  });
});
