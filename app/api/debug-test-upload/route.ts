import { NextResponse } from "next/server";
import sharp from "sharp";
import { createAdminSupabase } from "@/lib/supabase/admin";

export async function GET() {
  const supabase = createAdminSupabase();

  const original = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).jpeg().toBuffer();

  const jpeg = await sharp(original).jpeg({ quality: 90 }).toBuffer();
  const magicBytesBeforeUpload = jpeg.subarray(0, 3).toString("hex");

  const path = `debug-nextjs-test-${Date.now()}.jpg`;
  const { error: upErr } = await supabase.storage
    .from("images")
    .upload(path, jpeg, { contentType: "image/jpeg", upsert: true });

  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  const { data: pub } = supabase.storage.from("images").getPublicUrl(path);
  const res = await fetch(pub.publicUrl);
  const downloaded = Buffer.from(await res.arrayBuffer());
  const magicBytesAfterDownload = downloaded.subarray(0, 3).toString("hex");

  let replacementCount = 0;
  for (let i = 0; i < downloaded.length - 2; i++) {
    if (downloaded[i] === 0xef && downloaded[i + 1] === 0xbf && downloaded[i + 2] === 0xbd) {
      replacementCount++;
    }
  }

  await supabase.storage.from("images").remove([path]);

  return NextResponse.json({
    uploadedLength: jpeg.length,
    downloadedLength: downloaded.length,
    magicBytesBeforeUpload,
    magicBytesAfterDownload,
    bytesMatch: Buffer.compare(downloaded, jpeg) === 0,
    replacementCharCount: replacementCount,
  });
}
