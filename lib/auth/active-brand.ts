import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listBrandsForUser, pickDefaultBrand } from "@/lib/brands";
import type { BrandProfile } from "@/lib/types";

export const ACTIVE_BRAND_COOKIE = "active_brand";

// Governs what the user SEES. It must never decide what gets prompted —
// generation paths derive brand from the category they are acting on
// (spec §3.2), so switching brands mid-generation cannot poison a prompt.
export function selectActiveBrand(
  brands: BrandProfile[],
  cookieValue: string | undefined,
): BrandProfile | null {
  const fromCookie = cookieValue ? brands.find((b) => b.id === cookieValue) : undefined;
  return fromCookie ?? pickDefaultBrand(brands);
}

// For API routes and server actions. redirect() throws NEXT_REDIRECT, which a
// page turns into a navigation but a Route Handler surfaces as an opaque
// server error — so those callers take the null and return their own error.
export async function getActiveBrand(userId: string): Promise<BrandProfile | null> {
  const brands = await listBrandsForUser(userId);
  const cookieStore = await cookies();
  return selectActiveBrand(brands, cookieStore.get(ACTIVE_BRAND_COOKIE)?.value);
}

// For pages only.
export async function requireActiveBrand(userId: string): Promise<BrandProfile> {
  const active = await getActiveBrand(userId);
  if (!active) redirect("/onboarding");
  return active;
}
