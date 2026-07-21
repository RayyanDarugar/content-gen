import { NextResponse } from "next/server";
import sharp from "sharp";
import https from "https";

function countReplacementChar(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) count++;
  }
  return count;
}

function rawHttpsPut(url: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "PUT",
        headers: { ...headers, "Content-Length": body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function GET() {
  const jpeg = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).jpeg({ quality: 90 }).toBuffer();

  const path = `debug-rawhttps-test-${Date.now()}.jpg`;
  const uploadUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/images/${path}`;

  const uploadRes = await rawHttpsPut(uploadUrl, jpeg, {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "image/jpeg",
    "x-upsert": "true",
  });

  if (uploadRes.status < 200 || uploadRes.status >= 300) {
    return NextResponse.json(
      { error: `upload failed: HTTP ${uploadRes.status}: ${uploadRes.body}` },
      { status: 500 },
    );
  }

  const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/images/${path}`;

  return NextResponse.json({
    path,
    publicUrl,
    uploadedLength: jpeg.length,
    uploadedMagicBytes: jpeg.subarray(0, 3).toString("hex"),
    uploadStatus: uploadRes.status,
  });
}
