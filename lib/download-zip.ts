import { buildSlideView } from "@/lib/athena/slide-view";
import { publishedImageUrl } from "@/lib/athena/published-image";
import type { Generation } from "@/lib/types";

export interface ZipEntry {
  url: string;
  name: string;
}

// Pure — the route's fetching and zipping sit around this, so the selection
// and naming rules are testable without network or a zip library.
//
// buildSlideView is reused so the zip contains exactly the slides the Gallery
// shows as current, never a superseded retry.
export function zipEntriesForIdea(
  generations: Generation[],
  slideCount: number,
): ZipEntry[] {
  const { slides } = buildSlideView(generations, slideCount);
  const entries: ZipEntry[] = [];

  for (const slot of slides) {
    const gen = slot.generation;
    if (!gen || gen.status !== "succeeded") continue;
    const url = publishedImageUrl(gen);
    if (!url) continue;
    // Named by CAROUSEL POSITION, not array index: a missing slide must not
    // renumber the ones after it, or slide 3 arrives as "02.jpg" and the zip
    // misrepresents the post's order.
    entries.push({ url, name: `${String(slot.slide_index + 1).padStart(2, "0")}.jpg` });
  }

  return entries;
}
