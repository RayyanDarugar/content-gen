import "server-only";
import Anthropic from "@anthropic-ai/sdk";

export type MajordomoFeature =
  | "brand_analysis"
  | "category_draft"
  | "category_suggest"
  | "format_draft"
  | "post_caption_adapt"
  | "post_caption_rewrite"
  | "content_idea_generation"
  | "content_idea_filter"
  | "content_preview";

export function createAnthropicClient(opts: {
  apiKey: string;
  feature: MajordomoFeature;
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
