import { describe, it, expect } from "vitest";
import { validateSlideShape } from "@/lib/athena/slides";
import type { Slide } from "@/lib/types";

const s = (role: Slide["role"], text = "t", visual = "v"): Slide => ({ role, text, visual });

describe("validateSlideShape", () => {
  it("accepts hook + beats + payoff at the expected count", () => {
    const slides = [s("hook"), s("beat"), s("beat"), s("beat"), s("payoff")];
    expect(validateSlideShape(slides, 5)).toEqual({ ok: true, reason: "" });
  });

  it("accepts a lone single slide", () => {
    expect(validateSlideShape([s("single")], 1)).toEqual({ ok: true, reason: "" });
  });

  it("rejects an empty array", () => {
    expect(validateSlideShape([], 5).ok).toBe(false);
  });

  it("rejects the wrong slide count", () => {
    const slides = [s("hook"), s("beat"), s("payoff")];
    expect(validateSlideShape(slides, 5)).toEqual({
      ok: false,
      reason: "expected 5 slides, got 3",
    });
  });

  it("rejects a first slide that is not a hook", () => {
    const slides = [s("beat"), s("beat"), s("payoff")];
    expect(validateSlideShape(slides, 3).ok).toBe(false);
  });

  it("rejects a last slide that is not a payoff", () => {
    const slides = [s("hook"), s("beat"), s("beat")];
    expect(validateSlideShape(slides, 3).ok).toBe(false);
  });

  it("rejects a non-beat in the middle", () => {
    const slides = [s("hook"), s("payoff"), s("payoff")];
    expect(validateSlideShape(slides, 3).ok).toBe(false);
  });

  it("requires role 'single' when the count is 1", () => {
    expect(validateSlideShape([s("hook")], 1).ok).toBe(false);
  });

  it("rejects a slide with neither text nor visual", () => {
    const slides = [s("hook"), s("beat", "", ""), s("payoff")];
    expect(validateSlideShape(slides, 3).ok).toBe(false);
  });

  it("allows a slide with a visual but no text (a wordless panel)", () => {
    const slides = [s("hook"), s("beat", "", "a wide empty desk"), s("payoff")];
    expect(validateSlideShape(slides, 3).ok).toBe(true);
  });
});
