import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { runAutopilotTick } from "@/lib/autopilot/tick";

export const maxDuration = 120;

// Same shape as app/api/jobs/poll/route.ts: constant-time comparison, and
// fail closed when CRON_SECRET is unset. A cron request carries no session,
// so requireUser() is never an option here.
function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

// Deliberately NOT folded into /api/jobs/poll: that job runs every 60s and
// spends its 120s budget on image ingestion, and a ~90s idea-generation call
// inside it would starve the work carousels depend on.
export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await runAutopilotTick();
    return NextResponse.json(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("autopilot tick failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
