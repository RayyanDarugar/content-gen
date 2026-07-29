import { mediaForPlatform, normalizeService } from "@/lib/platform";

export interface ChannelResult {
  channelId: string;
  status: "queued" | "failed";
  bufferUpdateId?: string;
  error?: string;
  // Set when the channel genuinely posted (status stays "queued") but some
  // bookkeeping after the Buffer call failed even after a retry — e.g. the
  // post_images insert, whose absence would make per-channel posted memory
  // (Task 2) think this channel's slides never went out. A Buffer post can't
  // be un-posted, so the channel still counts as queued; this just tells the
  // caller its record-keeping may be stale.
  warning?: string;
}

// A multi-channel submission is never wholly "posted" or "failed" when it
// was partial — a Buffer post cannot be un-posted, so the summary has to
// say exactly what happened.
export function summarizeFanOut(results: ChannelResult[]): {
  queued: number; failed: number; allFailed: boolean; label: string;
} {
  const queued = results.filter((r) => r.status === "queued").length;
  const failed = results.length - queued;
  const parts: string[] = [];
  if (queued) parts.push(`${queued} queued`);
  if (failed) parts.push(`${failed} failed`);
  return {
    queued, failed,
    allFailed: results.length > 0 && queued === 0,
    label: parts.join(" · "),
  };
}

// Critical (review): a channel that truncates the media strip (X's 4-image
// mosaic cap, via mediaForPlatform) only ever receives the FIRST N of the
// submitted images — slides beyond that never reach Buffer for that channel.
// The completeness rule (spec §3/§7: "the union of slides that actually
// succeeded somewhere") must therefore be computed from each queued
// channel's own truncated prefix, not from the full submitted list, or a
// slide dropped by every channel's truncation still gets recorded as if it
// reached one of them — permanently blocking it there and marking the idea
// "posted" when a slide never actually went out anywhere.
export function sentSlidesByIdea(
  ordered: { idea_id: string; slide_index: number }[],
  imageUrls: string[],
  channels: { service: string; queued: boolean }[],
): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const ch of channels) {
    if (!ch.queued) continue;
    const sentCount = mediaForPlatform(imageUrls, normalizeService(ch.service)).length;
    for (const g of ordered.slice(0, sentCount)) {
      const set = map.get(g.idea_id) ?? new Set<number>();
      set.add(g.slide_index);
      map.set(g.idea_id, set);
    }
  }
  return map;
}
