import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { submitGenerations } from "@/lib/athena/submit-generations";

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
