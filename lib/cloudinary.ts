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

// Documents (PDFs especially) must NOT go through /image/upload. Cloudinary's
// image pipeline treats PDF specially (per-page rasterization support), and
// accounts that have the security setting restricting inline PDF/ZIP delivery
// through the image/video paths enabled (added account-side after PDF/ZIP
// were used for phishing hosted on trusted Cloudinary domains) can make the
// delivered content-type unreliable — lib/document-preflight.ts already
// documents having seen a Cloudinary PDF link "come back as octet-stream".
// `/raw/upload` stores the file as an opaque blob outside that pipeline, so
// the delivery is a byte-for-byte passthrough with the content-type resolved
// from the extension in the delivery URL, same as any static file host.
// Raw resources don't track "format" separately from the public_id the way
// image resources do, so the extension must be baked into the public_id
// here — an extension-less raw upload would come back undownloadable by
// type just the same.
export async function uploadDocumentToCloudinary(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<{ publicId: string; url: string }> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloudName || !preset) throw new Error("Cloudinary env vars not configured");

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "document";
  const publicId = `brand-docs/${Date.now()}-${safeName}`;
  const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;
  const body = new URLSearchParams({ file: dataUri, upload_preset: preset, public_id: publicId });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`cloudinary upload failed: HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { public_id: string; secure_url: string };
  return { publicId: json.public_id, url: json.secure_url };
}
