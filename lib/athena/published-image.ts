import type { Generation } from "@/lib/types";

// The single chokepoint between a generation's two image artifacts.
//
// public_url is the CLEAN image. It is what Kie receives as the carousel
// anchor — see sweepOrphanedAnchors (app/api/jobs/poll/route.ts) and
// lib/athena/resubmit-slide.ts — so it must never carry an overlay, or the
// model spends every later slide trying to redraw a smeared QR code.
//
// composited_url is what a human or Buffer should see. Display and posting
// paths go through here; generation paths read public_url directly and
// deliberately do not.
//
// No "server-only" import: this is called from client components too
// (the Post composer).
export function publishedImageUrl(
  gen: Pick<Generation, "public_url" | "composited_url">,
): string {
  return gen.composited_url || gen.public_url;
}
