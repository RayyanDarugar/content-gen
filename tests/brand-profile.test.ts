import { describe, expect, it, vi, beforeEach } from "vitest";

const calls: { op: string; payload: unknown; filters: [string, string][] }[] = [];

function builder(op: string, payload: unknown) {
  const filters: [string, string][] = [];
  const entry = { op, payload, filters };
  calls.push(entry);
  const chain = {
    eq(column: string, value: string) { filters.push([column, value]); return chain; },
    select() { return chain; },
    single: async () => ({ data: { id: "new-brand" }, error: null }),
    then(resolve: (v: { error: null }) => void) { resolve({ error: null }); },
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      update: (payload: unknown) => builder("update", payload),
      insert: (payload: unknown) => builder("insert", payload),
      upsert: (payload: unknown) => builder("upsert", payload),
    }),
  }),
}));

import { saveBrandProfileForUser, createBrandForUser } from "@/lib/brand-profile";

const fields = {
  business_name: "  Rewire  ", business_description: "", audience: "", voice: "", avoid: "",
  proof_points: [], standing: [], colors: [], fonts: [], visual_notes: "",
};

beforeEach(() => { calls.length = 0; });

describe("saveBrandProfileForUser", () => {
  it("updates one brand by id and never upserts on user_id", async () => {
    await saveBrandProfileForUser("user-1", "brand-9", fields);
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("update");
    expect(calls[0].filters).toEqual([["id", "brand-9"], ["user_id", "user-1"]]);
  });

  it("persists the name trimmed", async () => {
    await saveBrandProfileForUser("user-1", "brand-9", fields);
    expect((calls[0].payload as { business_name: string }).business_name).toBe("Rewire");
  });

  it("rejects a blank name", async () => {
    await expect(
      saveBrandProfileForUser("user-1", "brand-9", { ...fields, business_name: "  " }),
    ).rejects.toThrow(/name/i);
  });
});

describe("createBrandForUser", () => {
  it("inserts a new row and returns its id", async () => {
    const id = await createBrandForUser("user-1", fields);
    expect(calls[0].op).toBe("insert");
    expect(id).toBe("new-brand");
  });
});
