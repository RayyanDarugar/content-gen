// Splits an idea's generations into "the carousel as it stands now" and
// "everything superseded".
//
// The gallery previously showed generations[0] — the newest row — as the card's
// single image and filed the rest under "history". That was right when an idea
// meant one image and extra rows really were prior attempts. With slides, the
// other rows are *siblings of one post*, so the card showed an arbitrary slide
// and mislabelled the other four as history.

export interface SlideGeneration {
  id: string;
  slide_index: number;
  status: string;
  created_at: string;
  anchor_generation_id?: string | null;
}

export interface SlideSlot<G> {
  slide_index: number;
  generation: G | null;
}

export interface SlideView<G> {
  slides: SlideSlot<G>[];
  superseded: G[];
}

// A succeeded generation always wins its slot over a newer failed retry —
// otherwise a failed retry would blank out an image the user can still post.
function better<G extends SlideGeneration>(candidate: G, current: G | null): boolean {
  if (!current) return true;
  const candidateWon = candidate.status === "succeeded";
  const currentWon = current.status === "succeeded";
  if (candidateWon !== currentWon) return candidateWon;
  return candidate.created_at > current.created_at;
}

export function buildSlideView<G extends SlideGeneration>(
  generations: G[],
  slideCount: number,
): SlideView<G> {
  const count = Math.max(1, slideCount);

  // Only slides belonging to the CURRENT anchor may fill a slot. Without this
  // the view borrows a previous anchor's image whenever the current one's
  // slide failed — so a carousel that is genuinely incomplete looks finished,
  // its status looks stuck at "generating", and the images on screen come
  // from two different anchors, which is the mixed-anchor carousel the whole
  // anchor-scoping design exists to prevent.
  const anchors = generations.filter((g) => g.slide_index === 0 && g.status === "succeeded");
  const anchor = anchors.length
    ? anchors.reduce((newest, g) => (g.created_at > newest.created_at ? g : newest))
    : null;

  // Before any anchor has succeeded there is nothing to scope to, so show
  // whatever exists — that is a first run in progress, not a mixed carousel.
  // Exclude a row only on positive evidence it belongs to a DIFFERENT anchor.
  // Rows carrying no anchor id at all predate anchor tracking (or come from a
  // path that never set it); dropping those would silently hide legacy
  // siblings, so they are kept.
  const inScope = anchor
    ? generations.filter((g) => {
        if (g.slide_index === 0) return g.id === anchor.id;
        return !g.anchor_generation_id || g.anchor_generation_id === anchor.id;
      })
    : generations;

  const chosen = new Map<number, G>();
  for (const gen of inScope) {
    if (gen.slide_index < 0 || gen.slide_index >= count) continue;
    if (better(gen, chosen.get(gen.slide_index) ?? null)) {
      chosen.set(gen.slide_index, gen);
    }
  }

  const keptIds = new Set([...chosen.values()].map((g) => g.id));
  return {
    slides: Array.from({ length: count }, (_, slide_index) => ({
      slide_index,
      generation: chosen.get(slide_index) ?? null,
    })),
    superseded: generations.filter((g) => !keptIds.has(g.id)),
  };
}
