import { describe, it, expect } from "vitest";
import { selectSource, type IdeaCandidate } from "@/lib/autopilot/sourcing";

function candidate(over: Partial<IdeaCandidate> = {}): IdeaCandidate {
  return {
    ideaId: "idea-ready",
    status: "generated",
    slideCount: 3,
    readySlideIndexes: [0, 1, 2],
    hasNonFailedPost: false,
    hasInFlightGeneration: false,
    claimedByLiveRun: false,
    createdAt: "2026-08-14T00:00:00Z",
    ...over,
  };
}

const budgeted = { candidates: [] as IdeaCandidate[], priorAttempt: null, ideaGenerationAvailable: true };

describe("selectSource", () => {
  it("tier 1: reuses the prior failed attempt's carousel, carrying its post group", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({ ideaId: "idea-a" }), candidate({ ideaId: "idea-b" })],
      priorAttempt: { ideaId: "idea-b", postGroupId: "group-1" },
    });
    expect(d).toEqual({
      action: "post", source: "retry_images", ideaId: "idea-b", postGroupId: "group-1",
    });
  });

  it("falls through to tier 2 when the prior attempt's idea is no longer postable", () => {
    // Its post actually queued on a retry elsewhere — it must not go out twice.
    const d = selectSource({
      ...budgeted,
      candidates: [
        candidate({ ideaId: "idea-b", hasNonFailedPost: true }),
        candidate({ ideaId: "idea-a" }),
      ],
      priorAttempt: { ideaId: "idea-b", postGroupId: "group-1" },
    });
    expect(d).toEqual({
      action: "post", source: "ready_images", ideaId: "idea-a", postGroupId: null,
    });
  });

  it("tier 2: takes the OLDEST fully-ready unposted carousel", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [
        candidate({ ideaId: "newer", createdAt: "2026-08-14T10:00:00Z" }),
        candidate({ ideaId: "older", createdAt: "2026-08-12T10:00:00Z" }),
      ],
    });
    expect(d).toMatchObject({ action: "post", ideaId: "older" });
  });

  it("tier 2 skips a partially-generated carousel", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({ readySlideIndexes: [0, 1] })],
    });
    expect(d).toEqual({ action: "generate_ideas", source: "generated" });
  });

  it("tier 2 skips a carousel another live run already claimed", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({ claimedByLiveRun: true })],
    });
    expect(d).toEqual({ action: "generate_ideas", source: "generated" });
  });

  it("tier 3: submits an approved idea rather than paying to write a new one", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({ ideaId: "appr", status: "approved", readySlideIndexes: [] })],
    });
    expect(d).toEqual({ action: "submit_images", source: "approved_idea", ideaId: "appr" });
  });

  it("tier 3 skips an approved idea that already has images in flight", () => {
    const d = selectSource({
      ...budgeted,
      candidates: [candidate({
        status: "approved", readySlideIndexes: [], hasInFlightGeneration: true,
      })],
    });
    expect(d).toEqual({ action: "generate_ideas", source: "generated" });
  });

  it("tier 4: generates fresh material when nothing is on the shelf", () => {
    expect(selectSource(budgeted)).toEqual({ action: "generate_ideas", source: "generated" });
  });

  it("defers instead of generating when the tick's generation budget is spent", () => {
    const d = selectSource({ ...budgeted, ideaGenerationAvailable: false });
    expect(d.action).toBe("defer");
  });

  it("still posts ready images even with the generation budget spent", () => {
    const d = selectSource({
      candidates: [candidate()], priorAttempt: null, ideaGenerationAvailable: false,
    });
    expect(d).toMatchObject({ action: "post", source: "ready_images" });
  });
});
