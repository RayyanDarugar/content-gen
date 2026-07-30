import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: vi.fn(async (request?: Request) => {
    if (request?.headers.get("authorization") === "Bearer valid-token") return { id: "user-1" };
    throw new Error("unauthorized");
  }),
}));

import { POST } from "@/app/api/mcp/route";

describe("MCP route auth", () => {
  it("rejects a request with no bearer token", async () => {
    const request = new Request("http://localhost/api/mcp", { method: "POST", body: "{}" });
    const response = await POST(request as never);
    expect(response.status).toBe(401);
  });

  it("accepts a request with a valid bearer token", async () => {
    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const response = await POST(request as never);
    expect(response.status).not.toBe(401);
  });
});
