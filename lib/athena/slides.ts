import type { Slide } from "@/lib/types";

export interface ShapeResult {
  ok: boolean;
  reason: string;
}

const OK: ShapeResult = { ok: true, reason: "" };

// A carousel is one story: a hook, some beats, a payoff. A single image is
// the same shape with one slide. Malformed carousels are discarded rather
// than repaired — a persistent failure rate here is a prompt problem.
export function validateSlideShape(slides: Slide[], expectedCount: number): ShapeResult {
  if (!Array.isArray(slides) || slides.length === 0) {
    return { ok: false, reason: "no slides" };
  }
  if (slides.length !== expectedCount) {
    return { ok: false, reason: `expected ${expectedCount} slides, got ${slides.length}` };
  }
  if (slides.some((slide) => !slide.text.trim() && !slide.visual.trim())) {
    return { ok: false, reason: "a slide has neither text nor visual" };
  }
  if (expectedCount === 1) {
    return slides[0].role === "single"
      ? OK
      : { ok: false, reason: `a one-slide carousel must use role "single", got "${slides[0].role}"` };
  }
  const roles = slides.map((slide) => slide.role);
  if (roles[0] !== "hook") {
    return { ok: false, reason: `first slide must be "hook", got "${roles[0]}"` };
  }
  if (roles[roles.length - 1] !== "payoff") {
    return { ok: false, reason: `last slide must be "payoff", got "${roles[roles.length - 1]}"` };
  }
  const middle = roles.slice(1, -1);
  if (!middle.every((role) => role === "beat")) {
    return { ok: false, reason: `middle slides must all be "beat", got [${middle.join(", ")}]` };
  }
  return OK;
}
