import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { submitGenerations } from "@/lib/athena/submit-generations";
import { resubmitSlide } from "@/lib/athena/resubmit-slide";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const ideaIds: unknown =
    body?.ideaIds ?? (typeof body?.ideaId === "string" ? [body.ideaId] : null);
  const refinementNotes =
    typeof body?.refinementNotes === "string" ? body.refinementNotes.trim() : "";
  // Retrying ONE slide of a carousel: it is regenerated against the anchor its
  // siblings already used, rather than re-anchoring and fanning out again.
  const slideIndex: unknown = body?.slideIndex;
  if (typeof slideIndex === "number") {
    if (!Number.isInteger(slideIndex) || slideIndex < 1) {
      return NextResponse.json(
        { error: "slideIndex must be an integer >= 1 (slide 0 re-anchors the whole carousel)" },
        { status: 400 },
      );
    }
    if (!Array.isArray(ideaIds) || ideaIds.length !== 1 || typeof ideaIds[0] !== "string") {
      return NextResponse.json(
        { error: "slideIndex applies to exactly one idea" },
        { status: 400 },
      );
    }
    try {
      const result = await resubmitSlide(user.id, ideaIds[0], slideIndex, refinementNotes);
      return NextResponse.json({ ...result, failed: 0, skipped: 0, errors: [] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("slide resubmit failed:", message);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (
    !Array.isArray(ideaIds) ||
    ideaIds.length === 0 ||
    !ideaIds.every((id) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "expected { ideaIds: string[] } or { ideaId: string }" },
      { status: 400 },
    );
  }

  try {
    const result = await submitGenerations(user.id, ideaIds as string[], refinementNotes);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("image submit failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
