interface RawIdea { idea_id: string; category: string; concept: string; }
interface Decision { idea_id: string; keep: boolean; reason: string; }

const NO_DECISION_REASON = "no decision returned — defaulting to keep";
export const FILTER_FAILED_REASON = "quality filter failed — kept without review";

export function applyFilterDecisions<T extends RawIdea>(
  ideas: T[],
  decisions: Decision[],
  fallbackReason: string = NO_DECISION_REASON,
) {
  const map = new Map(decisions.map((d) => [d.idea_id, d]));
  return ideas.map((idea) => {
    const d = map.get(idea.idea_id);
    return {
      ...idea,
      ai_keep: d?.keep ?? true,
      ai_filter_reason: d?.reason ?? fallbackReason,
    };
  });
}

/**
 * Runs the self-filter pass, failing OPEN.
 *
 * The pass is a quality gate sitting behind an idea-generation call that has
 * already been paid for and already succeeded. If the gate itself breaks —
 * the SDK throwing on truncated structured output was the observed case, but
 * a 5xx does it too — letting that propagate throws away the whole batch and
 * surfaces as a raw SDK parse error in the UI. Keeping every idea unreviewed
 * is the cheap failure: the user still reviews them by hand afterwards.
 *
 * `filterFailed` is reported separately from "the filter kept everything" so
 * the caller can tell the user which one happened.
 */
export async function filterWithFallback<T extends RawIdea>(
  ideas: T[],
  fetchDecisions: () => Promise<Decision[]>,
): Promise<{ merged: ReturnType<typeof applyFilterDecisions<T>>; filterFailed: boolean }> {
  try {
    return { merged: applyFilterDecisions(ideas, await fetchDecisions()), filterFailed: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`idea filter pass failed, keeping all ${ideas.length} ideas unreviewed: ${message}`);
    return { merged: applyFilterDecisions(ideas, [], FILTER_FAILED_REASON), filterFailed: true };
  }
}
