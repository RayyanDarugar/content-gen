export interface StatusInput {
  active: boolean;
  pausedReason: string;
  postsPerPeriod: number;
  landedGroups: number;
  attemptsUsed: number;
  maxAttempts: number;
  liveState: string | null;
}

export interface WorkflowStatus {
  tone: "on" | "done" | "working" | "paused" | "off";
  label: string;
}

// Every live AutopilotRunState, in the words a human would use. `publishing`
// is the claim state a run sits in while Buffer is being called, so it is the
// one most likely to be on screen mid-post — it needs its own phrase rather
// than the fall-through to the raw column value.
const STEP_WORDS: Record<string, string> = {
  sourcing: "choosing material",
  awaiting_images: "generating images",
  posting: "posting",
  publishing: "sending to Buffer",
};

// One sentence for the whole state of a workflow. Order matters: off beats
// everything (a paused workflow is doing nothing regardless of its counts),
// then a met quota, then live work, then the attempt cap.
export function describeWorkflowStatus(input: StatusInput): WorkflowStatus {
  if (!input.active) {
    return { tone: "off", label: input.pausedReason ? `paused: ${input.pausedReason}` : "off" };
  }
  if (input.landedGroups >= input.postsPerPeriod) {
    return { tone: "done", label: `posted ${input.landedGroups}/${input.postsPerPeriod}` };
  }
  if (input.liveState) {
    const step = STEP_WORDS[input.liveState] ?? input.liveState;
    return {
      tone: "working",
      label: `attempt ${input.attemptsUsed} of ${input.maxAttempts} — ${step}`,
    };
  }
  if (input.attemptsUsed >= input.maxAttempts) {
    return {
      tone: "paused",
      label: `gave up for this period (${input.attemptsUsed} of ${input.maxAttempts} attempts used)`,
    };
  }
  return {
    tone: "on",
    label: `waiting to start (${input.landedGroups}/${input.postsPerPeriod} posted)`,
  };
}
