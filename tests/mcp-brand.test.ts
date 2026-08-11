import { describe, expect, it, vi } from "vitest";
import type { BrandProfile } from "@/lib/types";

function brand(id: string, name: string): BrandProfile {
  return {
    id, user_id: "user-1", is_default: id === "b1", business_name: name,
    business_description: "", audience: "", voice: "", avoid: "",
    proof_points: [], standing: [], colors: [], fonts: [], visual_notes: "",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

const BRANDS = [brand("b1", "super{set}"), brand("b2", "Rewire")];

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: vi.fn(async (request?: Request) => {
    if (request?.headers.get("authorization") === "Bearer valid-token") return { id: "user-1" };
    throw new Error("unauthorized");
  }),
}));

// listBrandsForUser, resolveBrandByName, and brandForUser all stay real —
// none of @/lib/brands is mocked — so this exercises the actual resolution
// the tools depend on. What's faked is one level lower: the Supabase client
// listBrandsForUser queries.
//
// This is deliberate, not a stylistic choice: mocking @/lib/brands's
// listBrandsForUser export directly does NOT work here. brandForUser calls
// listBrandsForUser via a same-module reference (both are declared in
// lib/brands.ts), and Vitest's ESM module mock only intercepts *imports* of
// "@/lib/brands" from other files — it can't rewrite the intra-module
// function-to-function call, which keeps binding to the real, unmocked
// declaration. Mocking only the named export there left brandForUser calling
// the real listBrandsForUser, which called the real createAdminSupabase and
// failed with "supabaseUrl is required." instead of returning BRANDS.
// Faking the Supabase client instead reaches every caller of
// listBrandsForUser identically, whether invoked directly (list_brands) or
// through brandForUser (get_brand_profile).
function fakeQueryBuilder(result: { data: unknown; error: null }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    then: (resolve: (value: typeof result) => void) => resolve(result),
  };
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: vi.fn(() => ({
    from: (table: string) =>
      fakeQueryBuilder(table === "brand_profiles" ? { data: BRANDS, error: null } : { data: [], error: null }),
  })),
}));

vi.mock("@/lib/athena/brand-context", () => ({
  loadBrandContext: vi.fn(async (brandId: string) => ({ business_name: `loaded:${brandId}` })),
}));

import { POST } from "@/app/api/mcp/route";

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const request = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const response = await POST(request as never);
  // Read the raw body rather than parsing: mcp-handler may frame the reply as
  // JSON or as an SSE data frame, and the assertions below only care that the
  // resolver's message reached the caller either way.
  return await response.text();
}

describe("MCP tools route through brand resolution", () => {
  it("refuses to guess when the account has several brands and none was named", async () => {
    const body = await callTool("get_brand_profile", {});
    expect(body).toContain("super{set}");
    expect(body).toContain("Rewire");
    expect(body).not.toContain("loaded:b1");
  });

  it("loads the named brand when the argument is supplied", async () => {
    const body = await callTool("get_brand_profile", { brand: "Rewire" });
    expect(body).toContain("loaded:b2");
  });

  it("reports an unknown brand name instead of falling back to the default", async () => {
    const body = await callTool("get_brand_profile", { brand: "Kana" });
    expect(body).toContain("Kana");
    expect(body).not.toContain("loaded:b1");
  });

  it("list_brands returns every brand on the account", async () => {
    const body = await callTool("list_brands", {});
    expect(body).toContain("super{set}");
    expect(body).toContain("Rewire");
  });
});
