const MAX_ITEMS = 50;

// Brand lists arrive either as a real array (the extraction endpoint's
// structured output) or as a JSON string (the brand form posts FormData).
// One parser for both so the two paths cannot disagree about shape.
export function parseBrandList(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(value)) throw new Error("expected an array of strings");
  for (const item of value) {
    if (typeof item !== "string") throw new Error("expected an array of strings");
  }
  return (value as string[]).map((s) => s.trim()).filter(Boolean).slice(0, MAX_ITEMS);
}

// Case-insensitive, trimmed merge for brand lists (proof points, standing):
// existing items are kept as-is and never reordered, incoming items are
// appended in order, deduped against both what's already there AND each
// other (so the same extraction can't add "Acme" twice). Returns which
// incoming items actually landed as `added`, so the UI can mark them
// "added, not yet saved" without needing to diff the merge result itself.
export function mergeList(existing: string[], incoming: string[]): { merged: string[]; added: string[] } {
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
  const added: string[] = [];
  for (const raw of incoming) {
    const item = raw.trim();
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    added.push(item);
  }
  return { merged: [...existing, ...added], added };
}
