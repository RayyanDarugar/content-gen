"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import { listBrandsForUser } from "@/lib/brands";
import { ACTIVE_BRAND_COOKIE } from "@/lib/auth/active-brand";

// Every export of a "use server" module is a public POST endpoint, so this
// starts with requireUser(). selectActiveBrand already ignores a foreign
// brand id on read; the membership check here exists so switching to a brand
// you don't own fails loudly instead of silently landing on your default.
export async function setActiveBrand(brandId: string): Promise<void> {
  const user = await requireUser();
  const brands = await listBrandsForUser(user.id);
  if (!brands.some((b) => b.id === brandId)) throw new Error("unknown brand");

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_BRAND_COOKIE, brandId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
}
