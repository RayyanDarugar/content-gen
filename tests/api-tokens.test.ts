import { beforeEach, describe, expect, it, vi } from "vitest";

// The admin client bypasses RLS, so the `.eq("user_id", userId)` predicates in
// this module ARE the authorization boundary — these tests stand in for the
// policy that no longer applies. Same mocking convention as
// tests/brand-context.test.ts and tests/schedule-validated-post.test.ts.
const db = vi.hoisted(() => ({
  rows: [] as { id: string; user_id: string; token_hash: string }[],
  deleteFilters: [] as Record<string, string>[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      select: () => {
        const filters: Record<string, string> = {};
        const builder = {
          eq(column: string, value: string) {
            filters[column] = value;
            return builder;
          },
          async maybeSingle() {
            const row = db.rows.find((r) =>
              Object.entries(filters).every(([k, v]) => r[k as keyof typeof r] === v),
            );
            return { data: row ?? null, error: null };
          },
        };
        return builder;
      },
      // last_used_at touch — best-effort, nothing asserts on it.
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => {
        const filters: Record<string, string> = {};
        const builder = {
          eq(column: string, value: string) {
            filters[column] = value;
            return builder;
          },
          then(resolve: (value: { error: null }) => void) {
            db.deleteFilters.push({ ...filters });
            resolve({ error: null });
          },
        };
        return builder;
      },
    }),
  }),
}));

import {
  generateApiToken,
  hashToken,
  verifyApiToken,
  revokeApiTokenForUser,
} from "@/lib/auth/api-tokens";

beforeEach(() => {
  db.rows = [];
  db.deleteFilters = [];
});

describe("generateApiToken", () => {
  it("produces a token whose hash matches hashToken", () => {
    const { token, hash } = generateApiToken();
    expect(token.startsWith("cga_")).toBe(true);
    expect(hashToken(token)).toBe(hash);
  });

  it("produces different tokens on each call", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.token).not.toBe(b.token);
  });
});

describe("verifyApiToken", () => {
  it("resolves a stored token to its owner", async () => {
    const { token, hash } = generateApiToken();
    db.rows.push({ id: "token-1", user_id: "user-1", token_hash: hash });
    expect(await verifyApiToken(token)).toEqual({ userId: "user-1", tokenId: "token-1" });
  });

  it("rejects anything without the cga_ prefix before it ever hits the database", async () => {
    // Seeded so that a lookup WOULD succeed — the only thing left that can
    // reject this token is the prefix check.
    db.rows.push({ id: "token-1", user_id: "user-1", token_hash: hashToken("nope_abc123") });
    expect(await verifyApiToken("nope_abc123")).toBeNull();
  });

  it("rejects a Supabase session JWT — it is not an API token", async () => {
    expect(await verifyApiToken("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig")).toBeNull();
  });

  it("rejects a well-formed token whose hash is not stored (revoked or forged)", async () => {
    const { token } = generateApiToken();
    expect(await verifyApiToken(token)).toBeNull();
  });
});

describe("revokeApiTokenForUser", () => {
  it("scopes the delete to both the token id and its owner", async () => {
    await revokeApiTokenForUser("user-1", "token-1");
    // Without user_id in the filter, any user could revoke any token by id —
    // the admin client bypasses the RLS policy that used to prevent it.
    expect(db.deleteFilters).toEqual([{ id: "token-1", user_id: "user-1" }]);
  });
});
