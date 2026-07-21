import { NextResponse } from "next/server";
import sharp from "sharp";

function countReplacementChar(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) count++;
  }
  return count;
}

export async function GET() {
  const original = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).jpeg().toBuffer();

  const originalReplacementCount = countReplacementChar(original);
  const originalMagicBytes = original.subarray(0, 3).toString("hex");

  const jpeg = await sharp(original).jpeg({ quality: 90 }).toBuffer();
  const jpegReplacementCount = countReplacementChar(jpeg);
  const jpegMagicBytes = jpeg.subarray(0, 3).toString("hex");

  return NextResponse.json({
    originalLength: original.length,
    originalMagicBytes,
    originalReplacementCount,
    jpegLength: jpeg.length,
    jpegMagicBytes,
    jpegReplacementCount,
    jpegFirst40Hex: jpeg.subarray(0, 40).toString("hex"),
  });
}
