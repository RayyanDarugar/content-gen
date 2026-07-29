import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "@/lib/anthropic";

async function headersFor(client: ReturnType<typeof createAnthropicClient>) {
  const { req } = await client.buildRequest({ method: "post", path: "/v1/messages", body: {} });
  return req.headers as Headers;
}

describe("createAnthropicClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls the Anthropic API directly when MAJORDOMO_API_KEY is unset", async () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "");
    const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis" });
    expect(client.baseURL).toBe("https://api.anthropic.com");
    const headers = await headersFor(client);
    expect(headers.has("x-majordomo-key")).toBe(false);
    expect(headers.has("x-majordomo-feature")).toBe(false);
    expect(headers.has("x-majordomo-environment")).toBe(false);
  });

  it("calls the Anthropic API directly when MAJORDOMO_API_KEY is genuinely undefined (not just empty)", async () => {
    const original = process.env.MAJORDOMO_API_KEY;
    delete process.env.MAJORDOMO_API_KEY;
    try {
      const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis" });
      expect(client.baseURL).toBe("https://api.anthropic.com");
      const headers = await headersFor(client);
      expect(headers.has("x-majordomo-key")).toBe(false);
      expect(headers.has("x-majordomo-feature")).toBe(false);
      expect(headers.has("x-majordomo-environment")).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.MAJORDOMO_API_KEY;
      } else {
        process.env.MAJORDOMO_API_KEY = original;
      }
    }
  });

  it("routes through the Majordomo gateway tagged with feature and environment when MAJORDOMO_API_KEY is set", async () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "mdm_sk_test");
    vi.stubEnv("VERCEL_ENV", "production");
    const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis" });
    expect(client.baseURL).toBe("https://gateway.gomajordomo.com");
    const headers = await headersFor(client);
    expect(headers.get("x-majordomo-key")).toBe("mdm_sk_test");
    expect(headers.get("x-majordomo-feature")).toBe("brand_analysis");
    expect(headers.get("x-majordomo-environment")).toBe("production");
  });

  it("defaults X-Majordomo-Environment to \"development\" when VERCEL_ENV is unset", async () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "mdm_sk_test");
    vi.stubEnv("VERCEL_ENV", "");
    const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis" });
    const headers = await headersFor(client);
    expect(headers.get("x-majordomo-environment")).toBe("development");
  });

  it("passes maxRetries through in direct mode", () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "");
    const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis", maxRetries: 5 });
    expect(client.maxRetries).toBe(5);
  });

  it("passes maxRetries through in gateway mode", () => {
    vi.stubEnv("MAJORDOMO_API_KEY", "mdm_sk_test");
    const client = createAnthropicClient({ apiKey: "sk-ant-test", feature: "brand_analysis", maxRetries: 5 });
    expect(client.maxRetries).toBe(5);
  });
});
