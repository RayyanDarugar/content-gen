import { NextResponse, type NextRequest } from "next/server";
import JSZip from "jszip";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { zipEntriesForIdea } from "@/lib/download-zip";
import { slugForAttachment } from "@/lib/download-url";
import type { Generation, Idea } from "@/lib/types";

// Fetching and zipping several full-size images.
export const maxDuration = 120;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ideaId: string }> },
) {
  const { ideaId } = await params;

  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = await createServerSupabase();
  // Filtered by id AND user_id — never id alone.
  const { data } = await supabase
    .from("ideas").select("*, generations(*)")
    .eq("id", ideaId).eq("user_id", user.id).maybeSingle();
  if (!data) return NextResponse.json({ error: "unknown idea" }, { status: 404 });

  const idea = data as Idea & { generations: Generation[] };
  const slideCount = (idea.slides ?? []).length || 1;
  const entries = zipEntriesForIdea(idea.generations ?? [], slideCount);
  if (entries.length === 0) {
    return NextResponse.json({ error: "this post has no finished images" }, { status: 404 });
  }

  // Fetched concurrently — sequential fetches under a 20s-per-slide timeout
  // can blow past the route's own maxDuration once there are more than a
  // handful of slides. Results are collected by index (not push) so the zip
  // preserves entry order regardless of which fetch resolves first.
  const fetched = await Promise.all(
    entries.map(async (entry) => {
      try {
        const res = await fetch(entry.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.arrayBuffer();
      } catch (e) {
        // A partial download beats a 500 when four of five images are fine.
        console.error(`zip: skipping ${entry.name} for idea ${ideaId}:`, e);
        return null;
      }
    }),
  );

  const zip = new JSZip();
  let added = 0;
  entries.forEach((entry, i) => {
    const data = fetched[i];
    if (data === null) return;
    zip.file(entry.name, data);
    added++;
  });

  // An empty zip would look like success. Fail loudly instead.
  if (added === 0) {
    return NextResponse.json({ error: "could not fetch any images" }, { status: 502 });
  }

  const body = await zip.generateAsync({ type: "nodebuffer" });
  const filename = `${slugForAttachment(idea.concept)}.zip`;
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
