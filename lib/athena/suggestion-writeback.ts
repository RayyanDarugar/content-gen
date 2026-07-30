import type { FormatSuggestion, InventedFormat } from "@/lib/types";

export type WritebackPlan =
  | { kind: "none" }
  | { kind: "link"; formatId: string }
  | { kind: "create"; invented: InventedFormat };

// What to do when a suggestion is persisted into a real category for the
// first time. Pure, so the interesting decision is testable without a
// database: the route around it is a thin executor.
export function writebackPlan(
  suggestion: Pick<FormatSuggestion, "format_id" | "invented_format"> | null,
): WritebackPlan {
  if (!suggestion) return { kind: "none" };
  // Linking wins over creating. A suggestion that drew on the library must
  // never also mint a row, or every acceptance would duplicate its source.
  if (suggestion.format_id) return { kind: "link", formatId: suggestion.format_id };
  const invented = suggestion.invented_format;
  if (!invented?.structure?.trim()) return { kind: "none" };
  return { kind: "create", invented };
}

// The insert payload for an invented format. shared is false and unsettable
// by policy anyway, but it is written explicitly so the intent is legible at
// the call site: an invented row can only ever pollute its own tenant.
export function inventedFormatRow(userId: string, invented: InventedFormat) {
  return {
    user_id: userId,
    name: invented.name.trim() || "Untitled format",
    structure: invented.structure,
    why_it_works: invented.why_it_works,
    brand_fit: invented.brand_fit,
    source_example: "",
    screenshot_url: "",
    origin: "invented" as const,
    shared: false,
    active: true,
  };
}
