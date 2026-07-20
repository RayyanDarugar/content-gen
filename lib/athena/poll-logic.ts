export const POLL_CAP = 20;

export interface KieRecord {
  state: string;
  resultUrl: string | null;
}

export type PollDecision =
  | { action: "ingest"; resultUrl: string }
  | { action: "fail"; error: string }
  | { action: "wait"; pollCount: number };

export function decidePoll(record: KieRecord, currentPollCount: number): PollDecision {
  if (record.state === "success") {
    if (!record.resultUrl) {
      return { action: "fail", error: "Kie reported success but returned no result URL" };
    }
    return { action: "ingest", resultUrl: record.resultUrl };
  }
  if (record.state === "fail") {
    return { action: "fail", error: "Kie generation failed" };
  }
  const next = currentPollCount + 1;
  if (next >= POLL_CAP) {
    return {
      action: "fail",
      error: `poll cap reached (${POLL_CAP} polls, last state: ${record.state})`,
    };
  }
  return { action: "wait", pollCount: next };
}
