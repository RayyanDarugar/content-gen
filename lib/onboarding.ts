/**
 * Checklist state for /onboarding.
 *
 * Kept as a pure module (no "server-only", no React) so both the server page
 * and the client wizard can share one definition of "which step is the user
 * on", and so the ordering rules below are testable without a browser.
 */

export type StepState = "done" | "current" | "upcoming" | "locked";

export interface OnboardingProgress {
  /** An Anthropic API key is on file for the account. */
  keysDone: boolean;
  brandDone: boolean;
  categoryDone: boolean;
  ideasDone: boolean;
}

/**
 * Returns one state per step, in checklist order: keys, brand, post type, ideas.
 *
 * "locked" vs "upcoming" is the distinction that fixes the deadlock this
 * module was written for. Steps 2-4 each call an endpoint that runs through
 * requireAnthropicKey (brand extraction, category suggest/draft, idea
 * generation), so without a key they don't merely come later — they cannot
 * succeed at all, and letting the user click into them produces a raw
 * "Add your Anthropic API key in Config" error from a page that used to be
 * unreachable. So an unmet Anthropic key locks the outstanding steps after it,
 * while an ordinary not-yet-reached step is only "upcoming" (dimmed but usable
 * — you can legitimately hand-build a post type before finishing the brand).
 *
 * "done" always outranks "locked": accounts that escaped the old deadlock by
 * typing a brand name by hand really did complete that step, and reporting
 * genuine progress as locked would be a lie. Locking describes outstanding
 * work only.
 */
export function onboardingStepStates(progress: OnboardingProgress): StepState[] {
  const { keysDone, brandDone, categoryDone, ideasDone } = progress;
  const flags = [keysDone, brandDone, categoryDone, ideasDone];

  // The earliest incomplete step is "current"; -1 (nothing incomplete) makes
  // the comparison below false for every index, so all four read "done".
  const firstIncomplete = flags.indexOf(false);

  return flags.map((done, i) => {
    if (done) return "done";
    if (i > 0 && !keysDone) return "locked";
    return i === firstIncomplete ? "current" : "upcoming";
  });
}
