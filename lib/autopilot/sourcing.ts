import type { IdeaStatus } from "@/lib/types";

// How many ideas one tier-4 generation call asks for. The chosen one is
// approved and submitted; the rest stay at pending_review as inventory for the
// human queue and for tomorrow's tier 3. Two extra ideas in a call already
// being made cost almost nothing.
export const IDEA_BATCH = 3;

export interface IdeaCandidate {
  ideaId: string;
  status: IdeaStatus;
  slideCount: number;
  // Slide indexes resolvable to a succeeded generation UNDER THE CURRENT
  // ANCHOR — i.e. resolveValidSlides output, not a raw succeeded count.
  readySlideIndexes: number[];
  // Any prior post covering one of this idea's generations that did not fail.
  hasNonFailedPost: boolean;
  hasInFlightGeneration: boolean;
  claimedByLiveRun: boolean;
  createdAt: string;
}

export interface SourceInput {
  candidates: IdeaCandidate[];
  // The idea and post group of an earlier attempt in THIS period, if any.
  priorAttempt: { ideaId: string; postGroupId: string | null } | null;
  // Whether this tick still has its one idea-generation slot.
  ideaGenerationAvailable: boolean;
}

export type SourceDecision =
  | {
      action: "post";
      source: "retry_images" | "ready_images";
      ideaId: string;
      postGroupId: string | null;
    }
  | { action: "submit_images"; source: "approved_idea"; ideaId: string }
  | { action: "generate_ideas"; source: "generated" }
  | { action: "defer"; reason: string };

function isPostable(c: IdeaCandidate): boolean {
  if (c.status !== "generated") return false;
  if (c.hasNonFailedPost || c.claimedByLiveRun) return false;
  const ready = new Set(c.readySlideIndexes);
  for (let i = 0; i < c.slideCount; i++) if (!ready.has(i)) return false;
  return true;
}

function oldestFirst(a: IdeaCandidate, b: IdeaCandidate): number {
  return a.createdAt.localeCompare(b.createdAt);
}

// Tiers, in order. The first that yields material wins, and the tier is
// recorded on the run so the UI can say where the post came from.
export function selectSource(input: SourceInput): SourceDecision {
  const postable = input.candidates.filter(isPostable).sort(oldestFirst);

  // Tier 1 — the prior failed attempt's own carousel. A Buffer rejection
  // leaves the idea unposted with only failed post rows, so the SAME images
  // should go out again rather than being regenerated. Its post_group_id
  // rides along so createPostForUser's pre-post cleanup replaces the failed
  // rows instead of leaving a permanent "1 queued · 1 failed" ghost.
  if (input.priorAttempt) {
    const again = postable.find((c) => c.ideaId === input.priorAttempt!.ideaId);
    if (again) {
      return {
        action: "post", source: "retry_images",
        ideaId: again.ideaId, postGroupId: input.priorAttempt.postGroupId,
      };
    }
  }

  // Tier 2 — anything already generated and unposted, oldest first, so the
  // shelf drains in order rather than the newest carousel being posted forever.
  if (postable.length) {
    return { action: "post", source: "ready_images", ideaId: postable[0].ideaId, postGroupId: null };
  }

  // Tier 3 — an approved idea that has never been imaged.
  const approved = input.candidates
    .filter((c) => c.status === "approved" && !c.hasInFlightGeneration && !c.claimedByLiveRun)
    .sort(oldestFirst);
  if (approved.length) {
    return { action: "submit_images", source: "approved_idea", ideaId: approved[0].ideaId };
  }

  // Tier 4 — make new material, but only if this tick still has its slot. A
  // deferred workflow simply wins the slot on a later tick: whoever takes it
  // moves to awaiting_images and stops competing for it.
  if (!input.ideaGenerationAvailable) {
    return { action: "defer", reason: "idea-generation budget spent this tick" };
  }
  return { action: "generate_ideas", source: "generated" };
}
