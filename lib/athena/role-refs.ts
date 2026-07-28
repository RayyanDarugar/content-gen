import type { Category, Slide } from "@/lib/types";

// The one resolution rule for which reference image a slide generates
// against (spec §10): a promoted role ref replaces the brand style ref;
// style_ref_url is the fallback. Every first-assembly site (anchor submit,
// fan-out, preview) MUST go through this — retry paths replay the value
// stored on the generation row instead.
export function resolveRoleRef(
  category: Pick<Category, "style_ref_url" | "role_ref_urls">,
  role: Slide["role"],
): string {
  return category.role_ref_urls?.[role] || category.style_ref_url;
}

// Kie overwrites uploads on path collision (see uploadStyleRef), so a role
// ref must not reuse the brand ref's fileName. Passed as the categoryKey
// argument to uploadStyleRef.
export function roleRefUploadKey(categoryKey: string, role: Slide["role"], usedRoleRef: boolean): string {
  return usedRoleRef ? `${categoryKey}_${role}` : categoryKey;
}
