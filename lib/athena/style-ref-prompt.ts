import type { BrandContext } from "@/lib/athena/prompts";

// A placeholder brand style reference, generated with no seed image. This is
// pure text-to-image, so it must never attempt a logo or a specific product —
// a prior Kie test (2026-07-27) showed the generative route reliably fails at
// inventing a believable mark. Restricting every branch to an abstract
// color/texture/mood board keeps every generated placeholder honest about
// what it actually is.
export function buildStyleRefPrompt(brand: BrandContext, notes?: string): string {
  const hasDesignTokens =
    brand.colors.length > 0 || brand.fonts.length > 0 || brand.visual_notes.trim().length > 0;

  const lines: string[] = [
    "Generate an abstract brand style reference image: a flat background/texture study, not a photograph of any specific object, product, or logo.",
  ];

  if (hasDesignTokens) {
    lines.push("Base it on this brand's actual visual identity:");
    if (brand.colors.length) lines.push(`- Palette: ${brand.colors.join(", ")}`);
    if (brand.fonts.length) lines.push(`- Typographic feel: ${brand.fonts.join(", ")}`);
    if (brand.visual_notes.trim()) lines.push(`- Visual notes: ${brand.visual_notes.trim()}`);
  } else {
    lines.push(
      "No specific palette or type is known yet, so base the mood on the business itself:",
      `- What it is: ${brand.business_description || "a small business"}`,
      `- Voice: ${brand.voice || "plain and approachable"}`,
      `- Audience: ${brand.audience || "a general audience"}`,
    );
  }

  lines.push(
    "",
    "Absolute constraints: NO logo, NO wordmark, NO invented product photography, NO text overlays. This is a placeholder style board only — an abstract color-and-texture composition, nothing else.",
  );

  if (notes?.trim()) {
    lines.push("", `Additional direction for this regeneration: ${notes.trim()}`);
  }

  return lines.join("\n");
}
