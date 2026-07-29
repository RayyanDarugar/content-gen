import Anthropic, { type APIError } from "@anthropic-ai/sdk";

// The Anthropic SDK's error response body, e.g.
// { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }.
// Anthropic.APIError stores this whole thing on `.error` — the string on
// `.message` is `${status} ${JSON.stringify(body)}` (see
// node_modules/@anthropic-ai/sdk/core/error.js APIError.makeMessage), which
// is exactly the raw JSON a user should never see rendered in the UI.
type AnthropicErrorBody = { error?: { message?: unknown } };

function nestedMessage(e: APIError, fallback: string): string {
  const body = e.error as AnthropicErrorBody | null | undefined;
  const nested = body?.error?.message;
  return typeof nested === "string" && nested.trim() ? nested : fallback;
}

/**
 * Maps an error thrown by an Anthropic SDK call to a message worth showing
 * a user, falling back to the raw error message when nothing more specific
 * matches (never returns an empty string).
 *
 * Detection is based on the SDK's actual error shape — APIError and its
 * subclasses (RateLimitError, AuthenticationError, InternalServerError,
 * ...) carry a numeric `status` plus a `type` string lifted from the
 * response body's `error.type` (see
 * node_modules/@anthropic-ai/sdk/core/error.js, APIError.generate) — not on
 * string-matching `e.message`, which is brittle (Anthropic can reword it
 * freely; it's also where the raw JSON body ends up for many error shapes).
 */
export function friendlyLlmError(e: unknown): string {
  const rawMessage = (e instanceof Error ? e.message : String(e)).trim();
  const fallback = rawMessage || "Something went wrong.";

  if (!(e instanceof Anthropic.APIError)) {
    return fallback;
  }

  const status = e.status;
  const errorType = e.type; // e.g. "overloaded_error", "rate_limit_error", "authentication_error"

  if (status === 529 || errorType === "overloaded_error") {
    return "Claude is overloaded right now. Wait a moment and try again.";
  }
  if (status === 429 || errorType === "rate_limit_error") {
    return "Rate limit reached on your Anthropic API key — wait a moment and try again.";
  }
  if (
    status === 401 ||
    status === 403 ||
    errorType === "authentication_error" ||
    errorType === "permission_error"
  ) {
    return "Claude rejected your API key. Check your Anthropic key in Config.";
  }
  if (status === 400 || errorType === "invalid_request_error") {
    return `Claude rejected the request: ${nestedMessage(e, fallback)}`;
  }
  if (typeof status === "number" && status >= 500) {
    return "Claude had a server error. Try again in a moment.";
  }
  return fallback;
}
