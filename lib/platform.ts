export type PlatformKey = "tiktok" | "instagram" | "linkedin" | "x" | "generic";

// Same normalization the copy layer's platformPresetFor uses (trim +
// lowercase, twitter and x both meaning X), so a category's preview and its
// generated copy can never disagree about what platform it posts to.
export function normalizeService(service: string): PlatformKey {
  switch (service.trim().toLowerCase()) {
    case "tiktok": return "tiktok";
    case "instagram": return "instagram";
    case "linkedin": return "linkedin";
    case "twitter":
    case "x": return "x";
    default: return "generic";
  }
}

export function platformCharLimit(key: PlatformKey): number | null {
  return key === "x" ? 280 : null;
}

// X renders multiple images as a mosaic capped at four, not a carousel, so
// slides 5+ of a carousel would silently never appear. Truncating here —
// and using this for BOTH the preview and the outgoing payload — keeps the
// preview honest about what that platform actually receives.
const X_MAX_IMAGES = 4;

export function mediaForPlatform(imageUrls: string[], key: PlatformKey): string[] {
  return key === "x" ? imageUrls.slice(0, X_MAX_IMAGES) : [...imageUrls];
}
