// A small, playful palette cycled by category key so each content category
// reads as its own "channel" across the ideas/gallery/post pages — inspired
// by how social scheduling tools color-code channels.
const PALETTE = [
  "oklch(0.74 0.15 55)", // amber
  "oklch(0.72 0.18 20)", // coral
  "oklch(0.75 0.13 195)", // teal
  "oklch(0.74 0.14 320)", // pink
  "oklch(0.78 0.15 135)", // lime
];

export function categoryColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

// Brands get their own palette, deliberately distinct from the category
// colours above: on the cross-brand schedule a brand rail and a category dot
// can appear in the same row, and two different things sharing one colour
// language would read as a relationship that doesn't exist.
const BRAND_PALETTE = [
  "oklch(0.62 0.16 55)",  // the app's own primary — the default brand usually lands here
  "oklch(0.55 0.14 250)", // indigo
  "oklch(0.58 0.13 150)", // green
  "oklch(0.60 0.15 300)", // violet
  "oklch(0.60 0.14 25)",  // rust
];

export function brandColor(brandId: string): string {
  let hash = 0;
  for (let i = 0; i < brandId.length; i++) hash = (hash * 31 + brandId.charCodeAt(i)) >>> 0;
  return BRAND_PALETTE[hash % BRAND_PALETTE.length];
}
