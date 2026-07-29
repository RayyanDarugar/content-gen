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
