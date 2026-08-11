import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireKieKey } from "@/lib/settings/user-secrets";
import { getKieRecord } from "@/lib/athena/kie";
import {
  generateSamplePreviewIdea, submitPreviewAnchor, submitPreviewFanout,
} from "@/lib/athena/preview";
import { compositeOverlays } from "@/lib/athena/overlay-composite";
import { listOverlaysForCategory } from "@/lib/overlay-mutations";
import type { Category, Slide } from "@/lib/types";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const ROLES = new Set(["hook", "beat", "payoff", "single"]);
function isSlideArray(v: unknown): v is Slide[] {
  return (
    Array.isArray(v) && v.length > 0 &&
    v.every(
      (s) => s && typeof s === "object" &&
        ROLES.has((s as Slide).role) &&
        typeof (s as Slide).text === "string" &&
        typeof (s as Slide).visual === "string",
    )
  );
}

async function loadCategory(categoryId: string): Promise<Category | null> {
  const supabase = await createServerSupabase(); // RLS scopes to the caller
  const { data } = await supabase
    .from("categories").select("*").eq("id", categoryId).maybeSingle();
  return (data as Category) ?? null;
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryId = body?.categoryId;
  const phase = body?.phase;
  if (typeof categoryId !== "string" || (phase !== "start" && phase !== "fanout")) {
    return NextResponse.json(
      { error: 'expected { categoryId: string, phase: "start" | "fanout" }' }, { status: 400 });
  }

  try {
    const category = await loadCategory(categoryId);
    if (!category) return NextResponse.json({ error: "unknown category" }, { status: 404 });

    if (phase === "start") {
      const { concept, slides } = await generateSamplePreviewIdea(user.id, category);
      const { styleUrl, taskId } = await submitPreviewAnchor(user.id, category, slides);
      return NextResponse.json({ concept, slides, styleUrl, taskId });
    }

    // phase === "fanout"
    if (!isSlideArray(body?.slides) || typeof body?.styleUrl !== "string" ||
        typeof body?.anchorImageUrl !== "string" || !body.anchorImageUrl) {
      return NextResponse.json(
        { error: "fanout expects { slides, styleUrl, anchorImageUrl }" }, { status: 400 });
    }
    const { taskIds } = await submitPreviewFanout(
      user.id, category, body.slides, body.styleUrl, body.anchorImageUrl);
    return NextResponse.json({ taskIds });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("preview failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}

// Thin poll wrapper around getKieRecord — no DB row is involved anywhere in
// the preview path. Kie state values (from lib/athena/poll-logic.ts's
// decidePoll, lines 14 and 20 — getKieRecord in lib/athena/kie.ts:74 passes
// `state` straight through from Kie's API with no translation):
//   - "success" -> done; resultUrl holds the finished image
//   - "fail"    -> failed
//   - anything else (e.g. "waiting", "queuing", "generating") -> still in flight, keep polling
export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const taskId = request.nextUrl.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });
  try {
    const kieKey = await requireKieKey(user.id);
    const record = await getKieRecord(kieKey, taskId);

    // Compositing only when the caller names both a category and a role.
    // A poll missing either behaves exactly as before — which is what keeps
    // style-reference generation (no slide role, and a template asset rather
    // than a published post) from ever getting an overlay.
    const categoryId = request.nextUrl.searchParams.get("categoryId");
    const role = request.nextUrl.searchParams.get("role");
    if (record.state === "success" && record.resultUrl && categoryId && role) {
      try {
        const overlays = await listOverlaysForCategory(categoryId, user.id);
        const res = await fetch(record.resultUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const composited = await compositeOverlays(
          Buffer.from(await res.arrayBuffer()), overlays, role as Slide["role"],
        );
        if (composited) {
          return NextResponse.json({
            ...record,
            resultUrl: `data:image/jpeg;base64,${(await sharp(composited).jpeg({ quality: 90 }).toBuffer()).toString("base64")}`,
          });
        }
      } catch (e) {
        // A preview that shows the un-composited image beats a preview that
        // errors — the point of Test Run is seeing the generation at all.
        console.error("preview compositing failed:", e);
      }
    }
    return NextResponse.json(record);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
