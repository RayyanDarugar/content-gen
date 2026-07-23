import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { getKieRecord } from "@/lib/athena/kie";
import { decidePoll } from "@/lib/athena/poll-logic";
import { getKieKeyOrNull } from "@/lib/settings/user-secrets";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import type { Generation } from "@/lib/types";

export const maxDuration = 120;
const INGEST_CAP = 5;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const header = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

async function ingestImage(
  supabase: SupabaseClient,
  gen: Generation,
  resultUrl: string,
): Promise<void> {
  const res = await fetch(resultUrl);
  if (!res.ok) throw new Error(`image download failed (HTTP ${res.status})`);
  const original = Buffer.from(await res.arrayBuffer());
  const jpeg = await sharp(original).jpeg({ quality: 90 }).toBuffer();
  const { publicId, url } = await uploadImageToCloudinary(jpeg, "image/jpeg");
  const { error: rowErr } = await supabase
    .from("generations")
    .update({ status: "succeeded", image_path: publicId, public_url: url })
    .eq("id", gen.id);
  if (rowErr) throw new Error(`generation update failed: ${rowErr.message}`);
  await supabase.from("ideas").update({ status: "generated" }).eq("id", gen.idea_id);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from("generations")
    .select("*")
    .in("status", ["submitted", "polling"])
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const pending = (data ?? []) as Generation[];

  let polled = 0;
  let ingested = 0;
  let failed = 0;

  const keyCache = new Map<string, string | null>();
  async function kieKeyFor(uid: string): Promise<string | null> {
    if (!keyCache.has(uid)) keyCache.set(uid, await getKieKeyOrNull(uid));
    return keyCache.get(uid) ?? null;
  }

  for (const gen of pending) {
    try {
      const apiKey = await kieKeyFor(gen.user_id);
      if (!apiKey) continue; // owner removed their key; leave the row for a later tick
      polled++;
      const record = await getKieRecord(apiKey, gen.kie_task_id);
      const decision = decidePoll(record, gen.poll_count);
      if (decision.action === "wait") {
        await supabase
          .from("generations")
          .update({ status: "polling", poll_count: decision.pollCount })
          .eq("id", gen.id);
      } else if (decision.action === "fail") {
        failed++;
        await supabase
          .from("generations")
          .update({ status: "failed", error: decision.error })
          .eq("id", gen.id);
        await supabase.from("ideas").update({ status: "failed" }).eq("id", gen.idea_id);
      } else if (ingested < INGEST_CAP) {
        await ingestImage(supabase, gen, decision.resultUrl);
        ingested++;
      }
      // success beyond INGEST_CAP: leave untouched — next tick ingests it
      // (success never consumes poll_count, so the cap can't expire it).
    } catch (e) {
      // Transient per-row error (network, storage blip): log and let the next
      // tick retry — recordInfo is read-only so nothing is lost.
      console.error(`poll error for generation ${gen.id}:`, e);
    }
  }

  return NextResponse.json({ polled, ingested, failed, pending: pending.length });
}
