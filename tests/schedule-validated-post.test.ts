import { describe, expect, it, vi } from "vitest";

// Only the categories lookup needs to succeed for this test — the
// duplicate-channel-id check runs immediately after it and before any
// generations/siblings query, so nothing further needs mocking.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: { key: "cat1", active: true }, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

import { scheduleValidatedPost } from "@/app/api/posts/create/route";

describe("scheduleValidatedPost", () => {
  it("rejects a duplicate channelId in the channels selection, matching the HTTP route's own check", async () => {
    await expect(
      scheduleValidatedPost("user-1", {
        categoryKey: "cat1",
        generationIds: ["gen-1"],
        channels: [
          { connectionId: "conn-1", channelId: "chan-1", service: "instagram", caption: "hi" },
          { connectionId: "conn-1", channelId: "chan-1", service: "instagram", caption: "hi again" },
        ],
        caption: "hi",
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        postGroupId: null,
      }),
    ).rejects.toThrow(/duplicate channel/);
  });
});
