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
