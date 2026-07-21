import { NextResponse } from "next/server";
import sharp from "sharp";
import { createAdminSupabase } from "@/lib/supabase/admin";

export async function GET() {
  const supabase = createAdminSupabase();

  const jpeg = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).jpeg({ quality: 90 }).toBuffer();

  const path = `debug-writeonly-test-${Date.now()}.jpg`;
  const { error: upErr } = await supabase.storage
    .from("images")
    .upload(path, jpeg, { contentType: "image/jpeg", upsert: true });

  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  const { data: pub } = supabase.storage.from("images").getPublicUrl(path);

  // Deliberately NOT downloading/verifying/removing here — leave the object
  // in place so it can be checked from OUTSIDE this Vercel function (e.g. a
  // local curl), isolating whether the WRITE (from Vercel) corrupts the
  // stored bytes, independent of whether a subsequent read from Vercel does.
  return NextResponse.json({
    path,
    publicUrl: pub.publicUrl,
    uploadedLength: jpeg.length,
    uploadedMagicBytes: jpeg.subarray(0, 3).toString("hex"),
    uploadedFirst40Hex: jpeg.subarray(0, 40).toString("hex"),
  });
}
