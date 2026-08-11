import type { Post } from "@/lib/types";

export type ScheduleRow = { post: Post; brandName: string; brandId: string };

export type ScheduleBuckets = {
  scheduled: { date: string; rows: ScheduleRow[] }[];
  queued: ScheduleRow[];
};

// A post with no scheduled_at rides Buffer's own queue (0013) — Buffer, not
// this app, decides when it goes out. Resolving the real time would cost a
// Buffer API call per connection on every page load, so it is shown honestly
// as "in queue" instead of guessed at.
export function bucketSchedule(rows: ScheduleRow[]): ScheduleBuckets {
  const queued = rows.filter((r) => !r.post.scheduled_at);
  const timed = rows
    .filter((r) => r.post.scheduled_at)
    .sort((a, b) => a.post.scheduled_at!.localeCompare(b.post.scheduled_at!));

  const byDate = new Map<string, ScheduleRow[]>();
  for (const r of timed) {
    const date = r.post.scheduled_at!.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), r]);
  }

  return {
    scheduled: [...byDate.entries()].map(([date, rows]) => ({ date, rows })),
    queued,
  };
}
