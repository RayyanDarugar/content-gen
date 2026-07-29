export interface ChannelResult {
  channelId: string;
  status: "queued" | "failed";
  bufferUpdateId?: string;
  error?: string;
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
