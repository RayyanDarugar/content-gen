export interface StatusInput {
  active: boolean;
  pausedReason: string;
  postsPerPeriod: number;
  landedGroups: number;
  attemptsUsed: number;
  maxAttempts: number;
  // The period the page is reporting on, so a straggler run opened in an
  // earlier one can be labelled as such rather than silently renumbered.
  currentPeriod: string;
  // The run the tick would advance right now, whatever period it belongs to —
  // runAutopilotTick's own live-run query has no period filter, so neither can
  // this. A run opened just before a rollover stays live across it and keeps
  // being advanced (and posted); reporting only the new period's runs would
  // show "waiting to start" for a workflow that is actively spending money.
  // Its own attempt_no and period_start are carried here rather than reusing
  // the current period's attempt count, which would be a different run's.
  live: { state: string; attemptNo: number; periodStart: string } | null;
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
  if (input.live) {
    const step = STEP_WORDS[input.live.state] ?? input.live.state;
    const from =
      input.live.periodStart === input.currentPeriod ? "" : ` (from ${input.live.periodStart})`;
    return {
      tone: "working",
      label: `attempt ${input.live.attemptNo} of ${input.maxAttempts}${from} — ${step}`,
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
