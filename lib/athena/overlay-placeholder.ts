import "server-only";
import sharp from "sharp";
import type { CategoryOverlay } from "@/lib/types";

// A square, obviously-artificial block. Square because a slot has no real
// image to take an aspect ratio from, and computePlacement derives height from
// the overlay's own dimensions — so a square placeholder previews the slot's
// width faithfully and makes no claim about the height a real photo will have.
const PLACEHOLDER_PX = 400;

let cached: string | null = null;

async function placeholderDataUri(): Promise<string> {
  if (cached) return cached;
  const fill = await sharp({
    create: {
      width: PLACEHOLDER_PX, height: PLACEHOLDER_PX, channels: 4,
      background: { r: 128, g: 128, b: 128, alpha: 0.55 },
    },
  }).png().toBuffer();
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
