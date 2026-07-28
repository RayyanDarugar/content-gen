import type { PostType, RoleGuides } from "@/lib/types";

export interface CategoryFields {
  name: string;
  style_guide: string;
  output_format: string;
  style_ref_url: string;
  post_caption: string;
  buffer_channel_id: string;
  buffer_connection_id: string;
  caption_guide: string;
  buffer_channel_service: string;
  images_per_carousel: number;
  aspect_ratio: string;
  active: boolean;
  post_type: PostType;
  role_guides: RoleGuides;
}

const SLIDE_ROLES = new Set(["hook", "beat", "payoff", "single"]);

export function validateCategoryFields(f: CategoryFields) {
  if (!f.name.trim()) throw new Error("Name is required");
  if (!Number.isInteger(f.images_per_carousel) || f.images_per_carousel < 1 || f.images_per_carousel > 10) {
    throw new Error("images_per_carousel must be 1-10");
  }
  if (f.post_type !== "independent" && f.post_type !== "narrative") {
    throw new Error("post_type must be independent or narrative");
  }
  // A narrative carousel needs at least a hook and a payoff to be a story.
  if (f.post_type === "narrative" && f.images_per_carousel < 2) {
    throw new Error("A narrative post needs at least 2 slides — use independent for single images");
  }
  // role_guides is written straight to jsonb; validate it here rather than
  // letting a bad value throw later at generation time when
  // roleGuides[slide.role]?.trim() runs against a non-string.
  for (const [role, guide] of Object.entries(f.role_guides ?? {})) {
    if (!SLIDE_ROLES.has(role)) throw new Error(`role_guides has an unknown role "${role}"`);
    if (typeof guide !== "string") throw new Error(`role_guides.${role} must be a string`);
  }
}

export function slugify(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "CATEGORY";
}
