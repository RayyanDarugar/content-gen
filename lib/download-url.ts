// Pure, and no "server-only": the Gallery's download controls are client
// components.
//
// Cloudinary sets Content-Disposition: attachment when fl_attachment appears
// in the delivery URL, so a download needs no route, no proxy and no
// buffering — the browser pulls straight from the CDN.

const HOST = "https://res.cloudinary.com/";
const UPLOAD_MARKER = "/image/upload/";

// Cloudinary delimits transformation components with "/" and ",", so an
// unsanitised concept string would corrupt the URL rather than name the file.
export function slugForAttachment(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "download";
}

// Anything that is not a recognisable Cloudinary IMAGE upload URL is returned
// unchanged — a data URI (Test Run previews produce these), another host, an
// empty string, or a /raw/upload document URL. Blind insertion would corrupt
// all of them, and a plain link is a working fallback.
export function attachmentUrl(url: string, filename?: string): string {
  if (!url.startsWith(HOST)) return url;
  const at = url.indexOf(UPLOAD_MARKER);
  if (at === -1) return url;

  const slug = filename ? slugForAttachment(filename) : "";
  const flag = slug ? `fl_attachment:${slug}` : "fl_attachment";
  const cut = at + UPLOAD_MARKER.length;
  return `${url.slice(0, cut)}${flag}/${url.slice(cut)}`;
}
