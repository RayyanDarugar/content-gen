import { beforeEach, describe, expect, it, vi } from "vitest";

// Every Tier 2 tool must refuse to touch anything before `confirm: true` is
// supplied. These tests drive the real route (so a newly-registered Tier 2
// tool that forgot assertConfirmed fails here) and assert on the side-effect
// modules themselves: not merely that an error came back, but that the
// mutation never ran.
const spies = vi.hoisted(() => ({
  deleteCategoryForUser: vi.fn(async () => {}),
  removeBufferConnection: vi.fn(async () => {}),
  submitGenerations: vi.fn(async () => ({})),
  resubmitSlide: vi.fn(async () => ({})),
  scheduleValidatedPost: vi.fn(async () => ({ postGroupId: "pg-1", results: [], allFailed: false })),
  submitStyleRefJobForUser: vi.fn(async () => ({ jobId: "job-1" })),
}));

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/category-mutations", () => ({
  createCategoryForUser: vi.fn(),
  updateCategoryForUser: vi.fn(),
  clearRoleRefUrlForUser: vi.fn(),
  deleteCategoryForUser: spies.deleteCategoryForUser,
}));
vi.mock("@/lib/settings/buffer", () => ({
  listBufferConnections: vi.fn(),
  getBufferChannelsForConnection: vi.fn(),
  removeBufferConnection: spies.removeBufferConnection,
}));
vi.mock("@/lib/athena/submit-generations", () => ({ submitGenerations: spies.submitGenerations }));
vi.mock("@/lib/athena/resubmit-slide", () => ({ resubmitSlide: spies.resubmitSlide }));
vi.mock("@/app/api/posts/create/route", () => ({ scheduleValidatedPost: spies.scheduleValidatedPost }));
vi.mock("@/lib/style-ref-jobs", () => ({
  submitStyleRefJobForUser: spies.submitStyleRefJobForUser,
  getStyleRefJobForUser: vi.fn(),
}));

import { POST } from "@/app/api/mcp/route";

// Tool name -> arguments that are valid in every respect EXCEPT the missing
// `confirm: true` (so the only thing that can reject them is the gate) -> the
// tool's own confirmation summary, asserted so a passing test can't come from
// some unrelated error (an unknown tool name, a schema rejection) that happens
// to mention confirmation.
const TIER_2_CALLS: [string, Record<string, unknown>, string][] = [
  ["delete_category", { id: "cat-1" }, "permanently delete category cat-1"],
  ["remove_buffer_connection", { connectionId: "conn-1" }, "remove Buffer connection conn-1"],
  ["submit_image_generation", { ideaIds: ["idea-1"] }, "submit 1 idea(s) for image generation"],
  // slideIndex 1 is the second slide — the summary is 1-based on purpose.
  ["resubmit_slide", { ideaId: "idea-1", slideIndex: 1 }, "regenerate slide 2 of idea idea-1"],
  [
    "schedule_post",
    {
      categoryKey: "cat1",
      generationIds: ["gen-1"],
      channels: [{ connectionId: "conn-1", channelId: "chan-1", service: "instagram", caption: "hi" }],
      caption: "hi",
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    "schedule a post to 1 channel(s)",
  ],
  ["generate_style_ref", { categoryId: "cat-1" }, "generate a new brand reference image for category cat-1 (spends API credit)"],
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const request = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const response = await POST(request as never);
  return response.text();
}

describe("Tier 2 confirmation gate", () => {
  beforeEach(() => {
    for (const spy of Object.values(spies)) spy.mockClear();
  });

  it.each(TIER_2_CALLS)("%s refuses to act without confirm: true", async (name, args, summary) => {
    const body = await callTool(name, args);
    expect(body).toContain(`Not confirmed: this would ${summary}`);
    expect(body).toContain('"isError":true');
    for (const [spyName, spy] of Object.entries(spies)) {
      expect(spy, `${name} reached ${spyName} despite no confirmation`).not.toHaveBeenCalled();
    }
  });

  it("lets a confirmed call through to its side effect", async () => {
    await callTool("delete_category", { id: "cat-1", confirm: true });
    expect(spies.deleteCategoryForUser).toHaveBeenCalledWith("user-1", "cat-1");
  });
});

describe("schedule_post result surfacing", () => {
  const args = {
    categoryKey: "cat1",
    generationIds: ["gen-1"],
    channels: [{ connectionId: "conn-1", channelId: "chan-1", service: "instagram", caption: "hi" }],
    caption: "hi",
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    confirm: true,
  };

  it("errors instead of returning a success shape when every channel failed", async () => {
    spies.scheduleValidatedPost.mockResolvedValueOnce({
      postGroupId: "pg-1",
      results: [{ channelId: "chan-1", status: "failed", error: "buffer said no" }],
      allFailed: true,
    } as never);
    const body = await callTool("schedule_post", args);
    expect(body).toContain('"isError":true');
    expect(body).toContain("failed on every channel");
    // The retry needs the group id, so it stays in the error payload.
    expect(body).toContain("pg-1");
  });

  it("returns the result when at least one channel queued", async () => {
    spies.scheduleValidatedPost.mockResolvedValueOnce({
      postGroupId: "pg-2",
      results: [{ channelId: "chan-1", status: "queued", bufferUpdateId: "b-1" }],
      allFailed: false,
    } as never);
    const body = await callTool("schedule_post", args);
    expect(body).not.toContain('"isError":true');
    expect(body).toContain("pg-2");
  });
});
