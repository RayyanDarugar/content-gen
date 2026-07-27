import type { IdeaStatus } from "@/lib/types";

// An idea is eligible for (re)submission when:
// - it's fresh ("approved") or failed synchronously before any generation
//   was ever in flight ("failed");
// - it's complete and the caller supplied refinement notes — an explicit
//   regenerate;
// - it's stuck "generating" with nothing currently in flight for it. That
//   last clause is the honest definition of "retryable": the poll cron
//   deliberately never marks an idea "failed" again once a slide fails past
//   its retries (a dud slide shouldn't condemn the rest of the carousel), so
//   without this clause a stalled idea would never become retryable through
//   any route — the gallery's Retry button would keep silently doing
//   nothing. The in-flight check is what stops this from double-submitting
//   a slide that is merely still mid-poll.
export function isSubmitEligible(
  status: IdeaStatus,
  refinementNotes: string,
  hasInFlightGeneration: boolean,
): boolean {
  if (status === "approved" || status === "failed") return true;
  if (status === "generated") return refinementNotes !== "";
  if (status === "generating") return !hasInFlightGeneration;
  return false;
}
