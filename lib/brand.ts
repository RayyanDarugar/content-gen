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
