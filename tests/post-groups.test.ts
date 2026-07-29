import { describe, expect, it } from "vitest";
import { groupPosts } from "@/lib/athena/post-groups";

const row = (
  id: string, group: string, status: string, created_at: string,
  buffer_channel_id = `chan-${id}`, buffer_channel_service = "linkedin",
) => ({
  id, post_group_id: group, category_key: "CAT", created_at, scheduled_at: null,
  buffer_channel_id, buffer_channel_service, status, error: status === "failed" ? "nope" : "",
  caption: `copy ${id}`,
});

describe("groupPosts", () => {
  it("groups channels of one submission and summarizes them", () => {
    const groups = groupPosts([
      row("a", "g1", "queued", "2026-01-01"),
      row("b", "g1", "queued", "2026-01-01"),
      row("c", "g1", "failed", "2026-01-01"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].channels).toHaveLength(3);
    expect(groups[0]).toMatchObject({ queued: 2, failed: 1 });
    expect(groups[0].label).toBe("2 queued · 1 failed");
  });
  it("renders a single-channel post as a group of one", () => {
    const groups = groupPosts([row("a", "g1", "queued", "2026-01-01")]);
    expect(groups[0].channels).toHaveLength(1);
    expect(groups[0].label).toBe("1 queued");
  });
  it("orders newest group first", () => {
    const groups = groupPosts([
      row("old", "g1", "queued", "2026-01-01"),
      row("new", "g2", "queued", "2026-02-01"),
    ]);
    expect(groups.map((g) => g.postGroupId)).toEqual(["g2", "g1"]);
  });
  it("returns nothing for no rows", () => {
    expect(groupPosts([])).toEqual([]);
  });

  // Minor (review): a legacy/other status (e.g. a pre-fan-out "created" row
  // that never progressed) must not be mislabeled as a failure — only an
  // actual "failed" row counts as failed.
  it("labels a legacy 'created' row neutrally rather than as failed", () => {
    const groups = groupPosts([
      row("a", "g1", "queued", "2026-01-01"),
      row("b", "g1", "created", "2026-01-01"),
    ]);
    expect(groups[0]).toMatchObject({ queued: 1, failed: 0, other: 1 });
    expect(groups[0].label).toBe("1 queued · 1 pending");
  });

  it("counts a lone 'created' row as pending, not failed", () => {
    const groups = groupPosts([row("a", "g1", "created", "2026-01-01")]);
    expect(groups[0]).toMatchObject({ queued: 0, failed: 0, other: 1 });
    expect(groups[0].label).toBe("1 pending");
  });
});
