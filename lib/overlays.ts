import type { OverlayCorner, OverlayShape, OverlayTint, Slide } from "@/lib/types";

export interface OverlayFields {
  name: string;
  image_url: string;
  is_slot: boolean;
  roles: Slide["role"][];
  corner: OverlayCorner;
  margin_pct: number;
  size_pct: number;
  opacity: number;
  shape: OverlayShape;
  // Percentage of the layer's own width.
  border_width_pct: number;
  border_color: string;
  tint: OverlayTint;
  tint_color: string;
  shadow: boolean;
  sort_order: number;
  active: boolean;
}

const ROLES = new Set<string>(["hook", "beat", "payoff", "single"]);
const CORNERS = new Set<string>([
  "top-left", "top-right", "bottom-left", "bottom-right", "center",
]);
const SHAPES = new Set<string>(["none", "circle", "rounded"]);
const TINTS = new Set<string>(["none", "grayscale", "color"]);
const HEX = /^#[0-9a-fA-F]{6}$/;

// Mirrors the CHECK constraints in 0021 plus the rules SQL cannot express.
// Validated here rather than only in the form because the *ForUser functions
// are reachable from the MCP surface in future phases.
export function validateOverlayFields(f: OverlayFields): void {
  if (!f.name.trim()) throw new Error("Give the overlay a name");
  // A slot's image comes from each idea's fill (spec §2), so it must NOT carry
  // one of its own — the fill would win at composite time and the configured
  // image would never appear.
  if (f.is_slot) {
    if (f.image_url.trim()) throw new Error("A slot's image comes from each idea — leave its image empty");
  } else if (!f.image_url.trim()) {
    throw new Error("Upload an image for the overlay");
  }
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

  if (!SHAPES.has(f.shape)) throw new Error(`Unknown shape "${f.shape}"`);
  if (!TINTS.has(f.tint)) throw new Error(`Unknown tint "${f.tint}"`);

  // A border with no colour renders transparent — the setting appears to do
  // nothing, with nothing on screen explaining why.
  if (f.border_width_pct < 0) throw new Error("Border width cannot be negative");
  if (f.border_width_pct > 25) throw new Error("Border must be 25 percent of the layer or less");
  if (f.border_width_pct > 0) {
    if (!f.border_color.trim()) throw new Error("Pick a border colour");
    if (!HEX.test(f.border_color.trim())) throw new Error("Border colour must be a hex value like #ff8800");
  }

  if (f.tint === "color") {
    if (!f.tint_color.trim()) throw new Error("Pick a tint colour");
    if (!HEX.test(f.tint_color.trim())) throw new Error("Tint colour must be a hex value like #ff8800");
  } else if (f.tint_color.trim()) {
    // Rejected rather than ignored: a colour sitting in the form doing
    // nothing is worse than being told it does not apply.
    throw new Error("Clear the tint colour, or set the tint to a colour tint");
  }
}
