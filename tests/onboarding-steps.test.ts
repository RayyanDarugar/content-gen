import { describe, expect, it } from "vitest";
import { onboardingStepStates, type OnboardingProgress } from "@/lib/onboarding";

function progress(over: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return { keysDone: false, brandDone: false, categoryDone: false, ideasDone: false, ...over };
}

describe("onboardingStepStates", () => {
  it("makes the keys step current on a brand-new account", () => {
    expect(onboardingStepStates(progress())).toEqual([
      "current", "locked", "locked", "locked",
    ]);
  });

  // The whole point of the fix: nothing downstream of the Anthropic key is
  // reachable until that key exists, because every one of those steps calls an
  // endpoint that throws "Add your Anthropic API key in Config" without it.
  it("locks every later incomplete step while the Anthropic key is missing", () => {
    const states = onboardingStepStates(progress({ brandDone: true }));
    expect(states).toEqual(["current", "done", "locked", "locked"]);
  });

  // Accounts that escaped the old deadlock by typing a brand name by hand have
  // genuinely completed those steps. Reporting real progress as "locked" would
  // be a lie, so "done" always wins — locking only ever applies to work that is
  // actually outstanding.
  it("keeps already-completed steps done even with no key on file", () => {
    const states = onboardingStepStates(
      progress({ brandDone: true, categoryDone: true, ideasDone: true }),
    );
    expect(states).toEqual(["current", "done", "done", "done"]);
  });

  it("unlocks the brand step once the key is saved", () => {
    expect(onboardingStepStates(progress({ keysDone: true }))).toEqual([
      "done", "current", "upcoming", "upcoming",
    ]);
  });

  // "upcoming", not "locked": step 3 has a real Build-my-own path that works
  // without a brand, so dimming is right where hard-blocking is not.
  it("marks unmet post-key steps upcoming rather than locked", () => {
    expect(onboardingStepStates(progress({ keysDone: true, brandDone: true }))).toEqual([
      "done", "done", "current", "upcoming",
    ]);
  });

  it("reports every step done on a fully set-up account", () => {
    const states = onboardingStepStates(
      progress({ keysDone: true, brandDone: true, categoryDone: true, ideasDone: true }),
    );
    expect(states).toEqual(["done", "done", "done", "done"]);
  });

  // A gap mid-checklist (ideas generated, but the post type since deleted)
  // still resolves to exactly one "current" — the earliest incomplete step —
  // and the later step keeps reporting the progress that really exists.
  it("treats only the earliest incomplete step as current", () => {
    const states = onboardingStepStates(
      progress({ keysDone: true, brandDone: true, ideasDone: true }),
    );
    expect(states).toEqual(["done", "done", "current", "done"]);
    expect(states.filter((s) => s === "current")).toHaveLength(1);
  });
});
