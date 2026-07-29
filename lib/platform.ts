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
