import { describe, it, expect } from "vitest";
import { isSubmitEligible } from "@/lib/athena/submit-eligibility";

describe("isSubmitEligible", () => {
  it("admits a fresh approved idea", () => {
    expect(isSubmitEligible("approved", "", false)).toBe(true);
  });

  it("admits an idea that failed synchronously", () => {
    expect(isSubmitEligible("failed", "", false)).toBe(true);
  });

  it("rejects a completed idea with no refinement notes", () => {
    expect(isSubmitEligible("generated", "", false)).toBe(false);
  });

  it("admits a completed idea when refinement notes are supplied", () => {
    expect(isSubmitEligible("generated", "make it bigger", false)).toBe(true);
  });

  it("rejects a generating idea with a generation still in flight", () => {
    expect(isSubmitEligible("generating", "", true)).toBe(false);
  });

  it("admits a generating idea once nothing is in flight for it — the stalled-carousel retry case", () => {
    expect(isSubmitEligible("generating", "", false)).toBe(true);
  });

  it("rejects pending_review and rejected regardless of notes or in-flight state", () => {
    expect(isSubmitEligible("pending_review", "notes", false)).toBe(false);
    expect(isSubmitEligible("rejected", "notes", false)).toBe(false);
  });

  it("rejects a posted idea", () => {
    expect(isSubmitEligible("posted", "", false)).toBe(false);
  });
});
