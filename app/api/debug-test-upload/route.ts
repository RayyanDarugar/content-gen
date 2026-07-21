import { NextResponse } from "next/server";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { fetch as undiciFetch } from "undici";

function countReplacementChar(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) count++;
  }
  return count;
}

export async function GET() {
  // Supabase client with an explicit, unpatched fetch (bypassing Next.js's
  // globalThis.fetch patch, which is the suspected corruption source).
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    // @ts-expect-error - undici's fetch type is close enough to the global fetch type for this test
    { global: { fetch: undiciFetch } },
  );

  const jpeg = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).jpeg({ quality: 90 }).toBuffer();

  const path = `debug-undici-test-${Date.now()}.jpg`;
  const { error: upErr } = await supabase.storage
    .from("images")
    .upload(path, jpeg, { contentType: "image/jpeg", upsert: true });

  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  const { data: pub } = supabase.storage.from("images").getPublicUrl(path);
  const res = await fetch(pub.publicUrl);
  const downloaded = Buffer.from(await res.arrayBuffer());

  await supabase.storage.from("images").remove([path]);

  return NextResponse.json({
    uploadedLength: jpeg.length,
    downloadedLength: downloaded.length,
    magicBytesBeforeUpload: jpeg.subarray(0, 3).toString("hex"),
    magicBytesAfterDownload: downloaded.subarray(0, 3).toString("hex"),
    bytesMatch: Buffer.compare(downloaded, jpeg) === 0,
    replacementCharCount: countReplacementChar(downloaded),
  });
}
