import "server-only";
import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicClient(opts: {
  apiKey: string;
  feature: string;
  maxRetries?: number;
}): Anthropic {
  const majordomoKey = process.env.MAJORDOMO_API_KEY;
  if (!majordomoKey) {
    return new Anthropic({ apiKey: opts.apiKey, maxRetries: opts.maxRetries });
  }
  return new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: opts.maxRetries,
    baseURL: "https://gateway.gomajordomo.com",
    defaultHeaders: {
      "X-Majordomo-Key": majordomoKey,
      "X-Majordomo-Feature": opts.feature,
      "X-Majordomo-Environment": process.env.VERCEL_ENV || "development",
    },
  });
}
