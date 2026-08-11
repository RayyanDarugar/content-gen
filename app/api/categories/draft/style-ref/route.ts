import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { loadBrandContext } from "@/lib/athena/brand-context";
import { requireKieKey } from "@/lib/settings/user-secrets";
import { createTextToImageKieTask } from "@/lib/athena/kie";
import { buildStyleRefPrompt } from "@/lib/athena/style-ref-prompt";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import type { Category } from "@/lib/types";
import { friendlyLlmError } from "@/lib/llm-errors";

export const maxDuration = 120;

const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryId = typeof body?.categoryId === "string" && body.categoryId ? body.categoryId : null;
  const phase = body?.phase;
  if (!categoryId || (phase !== "generate" && phase !== "finalize")) {
    return NextResponse.json(
      { error: 'expected { categoryId: string, phase: "generate" | "finalize" }' }, { status: 400 });
  }

  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.from("categories").select("*").eq("id", categoryId).maybeSingle();
    if (!data) return NextResponse.json({ error: "unknown category" }, { status: 404 });
    const category = data as Category;

    if (phase === "generate") {
      const notes = typeof body?.notes === "string" ? body.notes.slice(0, 500) : undefined;
      // Brand comes from the category being acted on, not the session
      // cookie — this route has a category in hand (loaded above), so the
      // active-brand cookie must never decide what gets prompted here. See
      // lib/style-ref-jobs.ts's submitStyleRefJobForUser for the MCP twin
      // that already does this correctly.
      const brand = await loadBrandContext(category.brand_id);
      const kieKey = await requireKieKey(user.id);
      const prompt = buildStyleRefPrompt(brand, notes);
      const taskId = await createTextToImageKieTask(kieKey, prompt, category.aspect_ratio);
      return NextResponse.json({ taskId });
    }

    // phase === "finalize"
    const imageUrl = body?.imageUrl;
    if (typeof imageUrl !== "string" || !imageUrl) {
      return NextResponse.json({ error: "finalize expects { imageUrl: string }" }, { status: 400 });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      return NextResponse.json({ error: "imageUrl is not a valid URL" }, { status: 400 });
    }
    if (parsedUrl.protocol !== "https:") {
      return NextResponse.json({ error: "imageUrl must be https" }, { status: 400 });
    }

    const fetched = await fetch(imageUrl);
    if (!fetched.ok) throw new Error(`fetching generated image failed with HTTP ${fetched.status}`);
    const contentType = (fetched.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      throw new Error(`expected an image response, got ${contentType || "unknown content-type"}`);
    }
    const contentLength = fetched.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      throw new Error("generated image exceeds 15MB limit");
    }
    const buffer = Buffer.from(await fetched.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) throw new Error("generated image exceeds 15MB limit");

    const { url: styleRefUrl } = await uploadImageToCloudinary(buffer, contentType);

    const { error } = await supabase
      .from("categories").update({ style_ref_url: styleRefUrl }).eq("id", categoryId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ styleRefUrl });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("style-ref generation failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}
