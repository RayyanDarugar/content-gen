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

// Spec §5.6: "A carousel is postable only if every slide has a succeeded
// generation under the same anchor. That is the check, and it is exact
// rather than count-based." Given every succeeded generation row for one
// idea, picks the current anchor (the newest succeeded slide 0) and returns
// only the indexes that succeeded *under that anchor* — a sibling generated
// against a previous, now-superseded anchor doesn't count, even though it is
// still the newest succeeded row for its own slide index. Without this, a
// mid-regeneration idea (new anchor succeeded, its fresh siblings still
// generating) would be seen as complete by pairing the new anchor with the
// old anchor's leftover siblings — exactly the silently-broken carousel the
// anchor scoping in the spec exists to prevent.
export function succeededIndexesUnderCurrentAnchor(
  rows: { id: string; slide_index: number; anchor_generation_id: string | null; created_at: string }[],
): number[] {
  const anchors = rows.filter((r) => r.slide_index === 0);
  if (!anchors.length) return [];
  const anchor = anchors.reduce((newest, r) => (r.created_at > newest.created_at ? r : newest));
  const indexes = [0];
  for (const r of rows) {
    if (r.slide_index !== 0 && r.anchor_generation_id === anchor.id) indexes.push(r.slide_index);
  }
  return indexes;
}

// Built when a generations insert fails *after* a Kie task was already
// created — the paid task exists but has no row to poll it. Without
// recording it somewhere, that spend is invisible: the sibling count used by
// shouldFanOut stays wrong forever (partial failure) or the sweep re-attempts
// the same paid submission indefinitely (total failure, count stuck at 0).
// Folding the taskId into the error column keeps the spend traceable even
// though the row itself is a failure.
export function orphanedTaskFailureRow(
  base: { user_id: string; idea_id: string; slide_index: number; anchor_generation_id?: string | null },
  taskId: string,
  insertErrorMessage: string,
): {
  user_id: string;
  idea_id: string;
  slide_index: number;
  anchor_generation_id?: string | null;
  status: "failed";
  error: string;
} {
  return {
    ...base,
    status: "failed",
    error: `generation insert failed after Kie task ${taskId} was already created: ${insertErrorMessage}`,
  };
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
