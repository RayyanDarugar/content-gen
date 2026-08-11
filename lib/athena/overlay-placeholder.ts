import "server-only";
import sharp from "sharp";
import type { CategoryOverlay } from "@/lib/types";

// A square, obviously-artificial block. Square because a slot has no real
// image to take an aspect ratio from, and computePlacement derives height from
// the overlay's own dimensions — so a square placeholder previews the slot's
// width faithfully and makes no claim about the height a real photo will have.
const PLACEHOLDER_PX = 400;
// Spec §6: "flat fill, a thin border" so the block is never mistaken for
// content, even at low overlay opacity where a borderless flat fill can read
// as a compositing artifact rather than a deliberate placeholder.
const BORDER_PX = 6;

let cached: string | null = null;

async function placeholderDataUri(): Promise<string> {
  if (cached) return cached;
  const inner = await sharp({
    create: {
      width: PLACEHOLDER_PX - BORDER_PX * 2, height: PLACEHOLDER_PX - BORDER_PX * 2, channels: 4,
      background: { r: 128, g: 128, b: 128, alpha: 0.55 },
    },
  }).png().toBuffer();
  const fill = await sharp({
    create: {
      // The border layer is the full square in a darker tone; the flat fill
      // is composited on top, inset by the border width, leaving a ring of
      // the darker tone visible around it.
      width: PLACEHOLDER_PX, height: PLACEHOLDER_PX, channels: 4,
      background: { r: 90, g: 90, b: 90, alpha: 0.85 },
    },
  })
    .composite([{ input: inner, left: BORDER_PX, top: BORDER_PX }])
    .png()
    .toBuffer();
  cached = `data:image/png;base64,${fill.toString("base64")}`;
  return cached;
}

// Test Run only. A slot has no idea to take an image from, so it gets a
// neutral block at its real computed placement — enough to judge position and
// size before any photo exists.
//
// Substituting a data: URI as image_url means compositeOverlays needs no
// change: it fetches image_url, and Node's fetch resolves data: URIs.
//
// Nothing here is ever persisted — no Cloudinary upload, no idea, no Buffer.
export async function placeholderFillOverlays(
  overlays: CategoryOverlay[],
): Promise<CategoryOverlay[]> {
  if (!overlays.some((o) => o.is_slot)) return overlays;
  const uri = await placeholderDataUri();
  return overlays.map((o) => (o.is_slot ? { ...o, image_url: uri } : o));
}
