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

  it("times out a document that never responds while a sibling still classifies normally", async () => {
    // Simulates real fetch's abort behavior: the mock never resolves on
    // its own, it only rejects once the signal fires — same as the
    // AbortSignal.timeout contract the real fetch honors.
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const href = url instanceof URL ? url.href : String(url);
      if (href.includes("hangs")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return Promise.resolve(
        new Response(null, { status: 200, headers: { "content-type": "application/pdf" } }),
      );
    }) as unknown as typeof fetch;

    const [hung, sibling] = await Promise.allSettled([
      preflightDocument("https://example.com/hangs.pdf", 20),
      preflightDocument("https://example.com/fine.pdf", 20),
    ]);

    expect(hung.status).toBe("rejected");
    if (hung.status === "rejected") {
      expect((hung.reason as Error).message.toLowerCase()).toContain("timed out");
    }
    expect(sibling.status).toBe("fulfilled");
    if (sibling.status === "fulfilled") {
      expect(sibling.value.kind).toBe("document");
    }
  });

  it("resumes the ranged-GET fallback from the URL the HEAD probe reached, not the original", async () => {
    const requests: string[] = [];
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const href = url instanceof URL ? url.href : String(url);
      requests.push(`${init?.method ?? "GET"} ${href}`);
      if (init?.method === "HEAD") {
        if (href === "https://cdn.example.com/deck.pdf") {
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: "https://cdn2.example.com/deck.pdf" } }),
          );
        }
        // The redirected HEAD lands with no content-type, triggering the fallback GET.
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200, headers: { "content-type": "application/pdf" } }));
    }) as unknown as typeof fetch;

    const result = await preflightDocument("https://cdn.example.com/deck.pdf", 1000);
    expect(result.kind).toBe("document");
    expect(requests).toEqual([
      "HEAD https://cdn.example.com/deck.pdf",
      "HEAD https://cdn2.example.com/deck.pdf",
      "GET https://cdn2.example.com/deck.pdf",
    ]);
  });
});
