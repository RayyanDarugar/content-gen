import type { OverlayCorner, Slide } from "@/lib/types";

export interface OverlayFields {
  name: string;
  image_url: string;
  roles: Slide["role"][];
  corner: OverlayCorner;
  margin_pct: number;
  size_pct: number;
  opacity: number;
  sort_order: number;
  active: boolean;
}

const ROLES = new Set<string>(["hook", "beat", "payoff", "single"]);
const CORNERS = new Set<string>([
  "top-left", "top-right", "bottom-left", "bottom-right", "center",
]);

// Mirrors the CHECK constraints in 0021 plus the rules SQL cannot express.
// Validated here rather than only in the form because the *ForUser functions
// are reachable from the MCP surface in future phases.
export function validateOverlayFields(f: OverlayFields): void {
  if (!f.name.trim()) throw new Error("Give the overlay a name");
  if (!f.image_url.trim()) throw new Error("Upload an image for the overlay");
  // An overlay with no roles composites nowhere — no effect, no error, and
  // nothing on screen to explain why.
  if (!f.roles.length) throw new Error("Pick at least one role for the overlay to appear on");
  for (const r of f.roles) {
    if (!ROLES.has(r)) throw new Error(`Unknown role "${r}"`);
  }
  if (!CORNERS.has(f.corner)) throw new Error(`Unknown corner "${f.corner}"`);
  if (!(f.size_pct > 0 && f.size_pct <= 100)) throw new Error("Size must be between 1 and 100 percent");
  // 50% margin from both sides leaves no room for the overlay at all.
  if (!(f.margin_pct >= 0 && f.margin_pct < 50)) throw new Error("Margin must be between 0 and 49 percent");
  if (!(f.opacity >= 0 && f.opacity <= 100)) throw new Error("Opacity must be between 0 and 100");
}
