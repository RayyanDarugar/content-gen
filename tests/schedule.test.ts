import { describe, expect, it } from "vitest";
import { bucketSchedule, type ScheduleRow } from "@/lib/schedule";
import type { Post } from "@/lib/types";

function row(id: string, scheduled_at: string | null, brandName: string, brandId = "b1"): ScheduleRow {
  return {
    post: {
      id, user_id: "u1", category_key: "K", buffer_update_id: "", post_group_id: "",
      buffer_channel_id: "", scheduled_at, adapted_from_caption: "",
      buffer_channel_service: "linkedin", caption: "", status: "queued", error: "",
      idea_id: null, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
    } as Post,
    brandName,
    brandId,
  };
}

describe("bucketSchedule", () => {
  it("separates fixed-time posts from posts riding Buffer's own queue", () => {
    const result = bucketSchedule([
      row("a", "2026-08-12T15:00:00Z", "super{set}"),
      row("b", null, "Rewire"),
    ]);
    expect(result.scheduled.flatMap((d) => d.rows).map((r) => r.post.id)).toEqual(["a"]);
    expect(result.queued.map((r) => r.post.id)).toEqual(["b"]);
  });

  it("groups fixed-time posts by calendar date, earliest first", () => {
    const result = bucketSchedule([
      row("late", "2026-08-14T09:00:00Z", "Kana"),
      row("early", "2026-08-12T09:00:00Z", "super{set}"),
      row("same-day", "2026-08-12T17:00:00Z", "Rewire"),
    ]);
    expect(result.scheduled.map((d) => d.date)).toEqual(["2026-08-12", "2026-08-14"]);
    expect(result.scheduled[0].rows.map((r) => r.post.id)).toEqual(["early", "same-day"]);
  });

  it("orders posts within a day by time", () => {
    const result = bucketSchedule([
      row("pm", "2026-08-12T17:00:00Z", "A"),
      row("am", "2026-08-12T09:00:00Z", "B"),
    ]);
    expect(result.scheduled[0].rows.map((r) => r.post.id)).toEqual(["am", "pm"]);
  });

  it("returns empty buckets for no posts", () => {
    expect(bucketSchedule([])).toEqual({ scheduled: [], queued: [] });
  });
});
