import type { CategoryOverlay, IdeaOverlayFill, Slide } from "@/lib/types";

export interface ResolvedOverlays {
  resolved: CategoryOverlay[];
  unfilled: CategoryOverlay[];
}

// Pure, and no server-only import: this is the core of B2 and it is only
// testable because no image I/O sits beside it — the same separation that
// makes computePlacement testable.
//
// Substituting the fill's image here means compositeOverlays receives ordinary
// overlays with image_url set and never learns slots exist, so B1's reviewed
// compositing is untouched.
export function resolveOverlaysForIdea(
  overlays: CategoryOverlay[],
  fills: IdeaOverlayFill[],
): ResolvedOverlays {
  const byOverlayId = new Map(fills.map((f) => [f.overlay_id, f]));
  const resolved: CategoryOverlay[] = [];
  const unfilled: CategoryOverlay[] = [];

  for (const o of overlays) {
    if (!o.is_slot) {
      resolved.push(o);
      continue;
    }
    const image = byOverlayId.get(o.id)?.image_url;
    if (image) {
      resolved.push({ ...o, image_url: image });
    } else if (o.active) {
      // Reported, not silently dropped: this documents which slots got
      // excluded from `resolved` (and therefore from compositing) and is
      // exercised by tests. None of the four "N slots unfilled" badge
      // surfaces actually read this list — app/(app)/ideas/idea-card.tsx,
      // app/(app)/gallery/page.tsx, and app/(app)/post/[ideaId]/page.tsx each
      // load category_overlays and idea_overlay_fills directly and recompute
      // the same filled/unfilled set themselves, since none of them call
      // resolveOverlaysForIdea. An inactive slot cannot composite anyway, so
      // badging it would be noise.
      unfilled.push(o);
    }
  }

  return { resolved, unfilled };
}

// Which of an idea's slides a change to one overlay actually affects. A
// payoff-only slot means one re-composite, not one per slide.
export function slideIndexesForRoles(slides: Slide[], roles: Slide["role"][]): number[] {
  const wanted = new Set<string>(roles);
  const out: number[] = [];
  slides.forEach((s, i) => {
    if (wanted.has(s.role)) out.push(i);
  });
  return out;
}
