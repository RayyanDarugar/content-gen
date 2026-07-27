// The cron runs repeatedly and a retried anchor produces a second slide-0
// generation, so "did the anchor just succeed" is not a safe trigger. The
// guard is keyed on the anchor itself rather than on "does this idea have
// any slide above index 0" — the weaker version would let an earlier run's
// slides block every subsequent re-anchor forever.
export function shouldFanOut(slideCount: number, existingUnderAnchor: number): boolean {
  return slideCount > 1 && existingUnderAnchor === 0;
}

export function slideIndexesToFanOut(slideCount: number): number[] {
  return Array.from({ length: Math.max(0, slideCount - 1) }, (_, i) => i + 1);
}

// An idea is only "generated" once every slide has an image. It used to flip
// on the first one, which was correct when an idea meant one image.
export function isCarouselComplete(slideCount: number, succeededIndexes: number[]): boolean {
  const succeeded = new Set(succeededIndexes);
  for (let i = 0; i < slideCount; i++) {
    if (!succeeded.has(i)) return false;
  }
  return true;
}

export const MAX_ANCHOR_ATTEMPTS = 3;

// The anchor gates every other slide, so a flaky failure there stalls the
// whole carousel rather than costing one image. Kie fails intermittently in
// proportion to prompt length — measured at ~40% on the longest style guide
// and ~10% elsewhere — so the anchor gets automatic retries where middle
// slides rely on the manual retry that already exists.
export function shouldRetryAnchor(anchorAttempts: number, anchorSucceeded: boolean): boolean {
  if (anchorSucceeded) return false;
  return anchorAttempts < MAX_ANCHOR_ATTEMPTS;
}
