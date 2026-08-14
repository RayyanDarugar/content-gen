// How long a run may sit in awaiting_images with nothing in flight before it
// is treated as stalled. Generous relative to a normal carousel (single-digit
// minutes) because the poll cron retries slides on its own schedule, and
// failing early would burn an attempt on work that was about to finish.
export const IMAGE_DEADLINE_MINUTES = 30;

export interface AwaitingInput {
  slideCount: number;
  readySlideIndexes: number[];
  hasInFlightGeneration: boolean;
  // When the run ENTERED awaiting_images, never when it was created. A run
  // deferred in `sourcing` (the tier-4 slot is one per tick, app-wide) can be
  // hours old before it submits anything, and measuring from creation would
  // fail a carousel minutes after paying for it.
  awaitingSince: string;
  now: Date;
}

export type AwaitingDecision =
  | { action: "post" }
  | { action: "wait" }
  | { action: "fail"; error: string };

// This step OBSERVES; it never acts. The poll cron owns fan-out, compositing,
// and slide retries — autopilot only reads what that work has produced.
export function decideAwaitingImages(input: AwaitingInput): AwaitingDecision {
  const ready = new Set(input.readySlideIndexes);
  let complete = true;
  for (let i = 0; i < input.slideCount; i++) if (!ready.has(i)) complete = false;
  if (complete) return { action: "post" };

  // Something is still cooking — including the ordinary gap where the anchor
  // has landed and the poll cron has not yet fanned out.
  if (input.hasInFlightGeneration) return { action: "wait" };

  const elapsedMs = input.now.getTime() - Date.parse(input.awaitingSince);
  if (elapsedMs < IMAGE_DEADLINE_MINUTES * 60_000) return { action: "wait" };

  // The RUN fails; the idea does not. The poll cron deliberately leaves a
  // stuck carousel at "generating" so its good slides stay visible and
  // postable by hand, and autopilot must not override that.
  return {
    action: "fail",
    error:
      `images stalled: ${ready.size} of ${input.slideCount} slides ready after ` +
      `${IMAGE_DEADLINE_MINUTES} min with nothing in flight`,
  };
}
