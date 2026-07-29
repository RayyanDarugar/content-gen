import { describe, it, expect, afterEach, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { friendlyLlmError } from "@/lib/llm-errors";

// Builds a real SDK error instance the same way the client does internally
// (Anthropic.APIError.generate, called from client.js's makeStatusError),
// so these tests exercise the actual shape rather than a hand-rolled mock.
function apiError(status: number, errorType: string, message: string) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type: errorType, message } },
    undefined,
    new Headers(),
  );
}

describe("friendlyLlmError", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps 529 overloaded_error to a wait-and-retry message", () => {
    const e = apiError(529, "overloaded_error", "Overloaded");
    expect(friendlyLlmError(e)).toBe("Claude is overloaded right now. Wait a moment and try again.");
  });

  it("maps 429 rate_limit_error to a BYOK-aware rate limit message", () => {
    const e = apiError(429, "rate_limit_error", "Rate limited");
    expect(friendlyLlmError(e)).toMatch(/rate limit/i);
    expect(friendlyLlmError(e)).toMatch(/api key/i);
  });

  it("maps 401 authentication_error to a Config pointer", () => {
    const e = apiError(401, "authentication_error", "invalid x-api-key");
    expect(friendlyLlmError(e)).toMatch(/config/i);
    expect(friendlyLlmError(e)).toMatch(/api key/i);
  });

  it("maps 403 permission_error to the same Config pointer", () => {
    const e = apiError(403, "permission_error", "forbidden");
    expect(friendlyLlmError(e)).toMatch(/config/i);
  });

  it("maps 400 invalid_request_error to a prefixed but still-actionable message", () => {
    const e = apiError(400, "invalid_request_error", "max_tokens: 999999 is too large");
    const msg = friendlyLlmError(e);
    expect(msg).toContain("max_tokens: 999999 is too large");
    expect(msg.toLowerCase()).toContain("request");
  });

  it("maps other 5xx statuses to a generic server error message", () => {
    const e = apiError(503, "api_error", "Service unavailable");
    expect(friendlyLlmError(e)).toBe("Claude had a server error. Try again in a moment.");
  });

  it("appends a gateway caveat to the 401 Config message when MAJORDOMO_API_KEY is set", () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "mdm_sk_test");
    const e = apiError(401, "authentication_error", "invalid x-api-key");
    expect(friendlyLlmError(e)).toBe(
      "Claude rejected your API key. Check your Anthropic key in Config (or the spend-tracking gateway is misconfigured).",
    );
  });

  it("appends a gateway caveat to the 500 server error message when MAJORDOMO_API_KEY is set", () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "mdm_sk_test");
    const e = apiError(503, "api_error", "Service unavailable");
    expect(friendlyLlmError(e)).toBe(
      "Claude had a server error. Try again in a moment (or the spend-tracking gateway is misconfigured).",
    );
  });

  it("falls back to the raw message for an unrecognized APIError status", () => {
    const e = apiError(404, "not_found_error", "model not found");
    expect(friendlyLlmError(e)).toContain("model not found");
  });

  it("falls back to the raw message for a plain Error", () => {
    const e = new Error("network hiccup");
    expect(friendlyLlmError(e)).toBe("network hiccup");
  });

  it("falls back to a non-empty message for a non-Error, non-APIError throw", () => {
    expect(friendlyLlmError("boom")).toBe("boom");
    expect(friendlyLlmError(undefined)).not.toBe("");
    expect(friendlyLlmError("")).not.toBe("");
  });
});
