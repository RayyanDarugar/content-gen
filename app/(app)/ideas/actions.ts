"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import { setIdeaDecisionForUser, createManualIdeaForUser } from "@/lib/idea-mutations";
import {
  setOverlayFillForUser, clearOverlayFillForUser,
} from "@/lib/overlay-fill-mutations";
import { recompositeIdeaForOverlay } from "@/lib/overlay-recomposite";
import type { Slide } from "@/lib/types";

// Every export of a "use server" file is a public endpoint reachable by direct
// POST, so each action here authenticates first and then delegates to the
// userId-parameterized core in lib/idea-mutations.ts — which deliberately does
// NOT live in this file, because exporting it here would publish an
// unauthenticated, tenant-id-taking mutation as a callable server action.
//
// No `export const maxDuration` here: per Next.js's own docs
// (route-segment-config/maxDuration.md, "Server Actions" section), that
// option is only recognized in layout.tsx / page.tsx / route.ts — for Server
// Actions it must be set at the PAGE level, not in the "use server" module
// itself. Declaring it here would be a silent no-op. setOverlayFill and
// clearOverlayFill below do real network + image work (re-compositing), so
// whichever page ends up calling them should set maxDuration = 120, matching
// every other image-touching route in this repo.

export async function setIdeaDecision(id: string, decision: "approved" | "rejected") {
  const user = await requireUser();
  await setIdeaDecisionForUser(user.id, id, decision);
  revalidatePath("/ideas");
}

export async function createManualIdea(input: {
  categoryKey: string;
  concept: string;
  slides: Slide[];
  postText?: string;
}): Promise<void> {
  const user = await requireUser();
  await createManualIdeaForUser(user.id, input);
  revalidatePath("/ideas");
}

export async function setOverlayFill(
  ideaId: string,
  overlayId: string,
  imageUrl: string,
): Promise<{ updated: number; failed: number }> {
  const user = await requireUser();
  await setOverlayFillForUser(user.id, ideaId, overlayId, imageUrl);
  // Brings already-generated slides into line without a regeneration. An idea
  // with no succeeded generations yet simply re-composites nothing — ingest
  // will resolve the fill when its images land. `failed` is surfaced to the
  // caller (see slot-strip.tsx) rather than discarded, so a transient
  // overlay-host outage that blanks composited_url is visible instead of
  // silently counted as success.
  const result = await recompositeIdeaForOverlay(user.id, ideaId, overlayId);
  revalidatePath("/ideas");
  revalidatePath("/gallery");
  // The composer's "N slots have no image" line reads this same idea; without
  // this the last look before publishing can show a stale count.
  revalidatePath("/post", "layout");
  return result;
}

export async function clearOverlayFill(
  ideaId: string,
  overlayId: string,
): Promise<{ updated: number; failed: number }> {
  const user = await requireUser();
  await clearOverlayFillForUser(user.id, ideaId, overlayId);
  // Re-composite AFTER the delete, so the removed layer actually disappears
  // from the published image — see the asymmetry note in lib/overlay-recomposite.ts.
  const result = await recompositeIdeaForOverlay(user.id, ideaId, overlayId);
  revalidatePath("/ideas");
  revalidatePath("/gallery");
  revalidatePath("/post", "layout");
  return result;
}
