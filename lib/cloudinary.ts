import "server-only";

export async function uploadImageToCloudinary(
  buffer: Buffer,
  mime: string,
): Promise<{ publicId: string; url: string }> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloudName || !preset) throw new Error("Cloudinary env vars not configured");

  // Base64 data URI in a URL-encoded body (pure ASCII) — Vercel's runtime
  // corrupts raw binary request bodies (see Phase 2 fix).
  const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;
  const body = new URLSearchParams({ file: dataUri, upload_preset: preset });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`cloudinary upload failed: HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { public_id: string; secure_url: string };
  return { publicId: json.public_id, url: json.secure_url };
}
