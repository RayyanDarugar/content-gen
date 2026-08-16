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

// "attempt 2 of 3 (from 2026-08-13) — sending to Buffer". The period only
// appears when the live run belongs to an earlier one, which is the straggler
// case the tick's own unfiltered live-run query creates.
function liveLabel(input: StatusInput, live: NonNullable<StatusInput["live"]>): string {
  const step = STEP_WORDS[live.state] ?? live.state;
  const from = live.periodStart === input.currentPeriod ? "" : ` (from ${live.periodStart})`;
  return `attempt ${live.attemptNo} of ${input.maxAttempts}${from} — ${step}`;
}

// One sentence for the whole state of a workflow. Order matters: off beats
// everything (a paused workflow is doing nothing regardless of its counts),
// then a met quota, then live work, then the attempt cap.
export function describeWorkflowStatus(input: StatusInput): WorkflowStatus {
  if (!input.active) {
    return { tone: "off", label: input.pausedReason ? `paused: ${input.pausedReason}` : "off" };
  }
  if (input.landedGroups >= input.postsPerPeriod) {
    const posted = `posted ${input.landedGroups}/${input.postsPerPeriod}`;
    // A met quota does NOT mean the workflow has stopped. tickWorkflow advances
    // a live run before it ever measures the gap, so a run still live past a
    // satisfied quota is about to publish a post that takes the category OVER
    // its stated rate. Reported by composing the two facts rather than by
    // reordering the branches: the count is still true and still shown, but the
    // tone and the trailing clause say the work is not finished. "posted 1/1"
    // on its own reads as settled, which is the same lie as "waiting to start"
    // reading as idle.
    if (input.live) {
      return { tone: "working", label: `${posted} · ${liveLabel(input, input.live)}` };
    }
    return { tone: "done", label: posted };
  }
  if (input.live) {
    return { tone: "working", label: liveLabel(input, input.live) };
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
