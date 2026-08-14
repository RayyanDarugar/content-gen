export interface QuotaInput {
  // Distinct non-failed post GROUPS in the period — a multi-channel post is
  // several rows of one publication.
  landedGroups: number;
  postsPerPeriod: number;
  attemptsUsed: number;
  maxAttempts: number;
}

export type QuotaDecision =
  | { action: "satisfied" }
  | { action: "exhausted"; attemptsUsed: number }
  | { action: "open"; attemptNo: number };

// The quota is checked BEFORE the cap: a period whose posts landed is
// satisfied no matter how many attempts it took to get there, and reporting
// it as "exhausted" would show a red state over a day that actually worked.
export function quotaGap(input: QuotaInput): QuotaDecision {
  if (input.landedGroups >= input.postsPerPeriod) return { action: "satisfied" };
  if (input.attemptsUsed >= input.maxAttempts) {
    return { action: "exhausted", attemptsUsed: input.attemptsUsed };
  }
  return { action: "open", attemptNo: input.attemptsUsed + 1 };
}

export interface SettleInput {
  lastSettledPeriod: string | null;
  currentPeriod: string;
  // Landed groups for lastSettledPeriod, bounded ABOVE by currentPeriod's
  // start — the caller must not let today's posts count toward yesterday.
  priorLandedGroups: number;
  postsPerPeriod: number;
  consecutiveFailedPeriods: number;
  autoPauseAfterFailedPeriods: number;
  lastError: string;
}

export type SettleDecision =
  | { action: "none" }
  | {
      action: "settle";
      consecutiveFailedPeriods: number;
      active: boolean;
      pausedReason: string;
      lastSettledPeriod: string;
    };

// Called once per workflow per period rollover. Judges the period just ended,
// then records that the current one is now the open period.
//
// Only the LAST settled period is judged, even if several elapsed while the
// app was idle. Counting untouched periods as failures would auto-pause a
// workflow for the app being down rather than for anything the workflow did.
export function settlePeriod(input: SettleInput): SettleDecision {
  if (input.lastSettledPeriod === input.currentPeriod) return { action: "none" };

  // A workflow seen for the first time has no prior period to judge.
  if (input.lastSettledPeriod === null) {
    return {
      action: "settle",
      consecutiveFailedPeriods: input.consecutiveFailedPeriods,
      active: true,
      pausedReason: "",
      lastSettledPeriod: input.currentPeriod,
    };
  }

  const met = input.priorLandedGroups >= input.postsPerPeriod;
  const failed = met ? 0 : input.consecutiveFailedPeriods + 1;
  const active = failed < input.autoPauseAfterFailedPeriods;
  const pausedReason = active
    ? ""
    : `missed quota ${failed} periods running` +
      (input.lastError ? `; last error: ${input.lastError}` : "");

  return {
    action: "settle",
    consecutiveFailedPeriods: failed,
    active,
    pausedReason,
    lastSettledPeriod: input.currentPeriod,
  };
}
