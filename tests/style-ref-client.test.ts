import { afterEach, describe, expect, it, vi } from "vitest";
import { generateStyleRef, persistStyleRef } from "@/lib/style-ref-client";

// Mocking convention matches tests/fetch-page.test.ts's
// "fetchPageHtml / fetchStylesheets (mocked fetch)" block:
// vi.spyOn(globalThis, "fetch").mockResolvedValue(...) / .mockImplementationOnce(...),
// never vi.stubGlobal.

// pollTask (lib/style-ref-client.ts) issues a single GET (no init object) to
// /api/categories/draft/preview?taskId=<id> and reads a JSON body shaped
// { state: "success", resultUrl } | { state: "fail" } | { state: <other> }.
// Every poll response below resolves to a terminal state ("success" or
// "fail") on the FIRST call, so pollTask never falls into its 5-second
// real-timer retry path.
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

describe("generateStyleRef (mocked fetch)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves to the finalized styleRefUrl on the happy path", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => jsonResponse(200, { taskId: "t1" }))
      .mockImplementationOnce(async () => jsonResponse(200, { state: "success", resultUrl: "https://example.com/img.png" }))
      .mockImplementationOnce(async () => jsonResponse(200, { styleRefUrl: "https://cloudinary.example/final.png" }));

    const result = await generateStyleRef("cat-1", "muted colors");

    expect(result).toBe("https://cloudinary.example/final.png");
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Call 1: generate phase
    const [genUrl, genInit] = fetchSpy.mock.calls[0];
    expect(genUrl).toBe("/api/categories/draft/style-ref");
    expect(genInit?.method).toBe("POST");
    expect(JSON.parse(genInit?.body as string)).toEqual({
      categoryId: "cat-1", phase: "generate", notes: "muted colors",
    });

    // Call 2: poll
    const [pollUrl] = fetchSpy.mock.calls[1];
    expect(pollUrl).toBe("/api/categories/draft/preview?taskId=t1");

    // Call 3: finalize phase
    const [finalUrl, finalInit] = fetchSpy.mock.calls[2];
    expect(finalUrl).toBe("/api/categories/draft/style-ref");
    expect(finalInit?.method).toBe("POST");
    expect(JSON.parse(finalInit?.body as string)).toEqual({
      categoryId: "cat-1", phase: "finalize", imageUrl: "https://example.com/img.png",
    });
  });

  it("propagates a generate-phase error without ever polling or finalizing", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => jsonResponse(500, { error: "kie key missing" }));

    await expect(generateStyleRef("cat-1")).rejects.toThrow("kie key missing");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed-poll error without calling finalize", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => jsonResponse(200, { taskId: "t1" }))
      .mockImplementationOnce(async () => jsonResponse(200, { state: "fail" }));

    await expect(generateStyleRef("cat-1")).rejects.toThrow("image generation failed");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("propagates a finalize-phase error", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => jsonResponse(200, { taskId: "t1" }))
      .mockImplementationOnce(async () => jsonResponse(200, { state: "success", resultUrl: "https://example.com/img.png" }))
      .mockImplementationOnce(async () => jsonResponse(502, { error: "upload to cloudinary failed" }));

    await expect(generateStyleRef("cat-1")).rejects.toThrow("upload to cloudinary failed");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("persistStyleRef (mocked fetch)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves to the styleRefUrl returned by the finalize phase", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => jsonResponse(200, { styleRefUrl: "https://cloudinary.example/final.png" }));

    const result = await persistStyleRef("cat-1", "https://example.com/uploaded.png");

    expect(result).toBe("https://cloudinary.example/final.png");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/categories/draft/style-ref");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      categoryId: "cat-1", phase: "finalize", imageUrl: "https://example.com/uploaded.png",
    });
  });

  it("propagates an error on a failed finalize response", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => jsonResponse(400, { error: "imageUrl is not a valid URL" }));

    await expect(persistStyleRef("cat-1", "not-a-url")).rejects.toThrow("imageUrl is not a valid URL");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
