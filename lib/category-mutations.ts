import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { type CategoryFields, validateCategoryFields, slugify } from "@/lib/categories";
import type { RoleRefUrls } from "@/lib/types";

// These `*ForUser` functions take the tenant's userId as a parameter and do
// NOT authenticate — every caller must have already established who the user
// is (the server actions in app/(app)/config/actions.ts via requireUser(), the
// MCP route via its bearer token). That is exactly why they live here and not
// in a "use server" file: every export of a "use server" module is a callable
// server action reachable by direct POST, which would turn an unauthenticated
// `deleteCategoryForUser(otherTenantId, id)` into a public endpoint. Same
// pattern as lib/athena/generate-ideas.ts, lib/settings/buffer.ts, etc.
//
// Named `lib/category-mutations.ts` rather than `lib/categories/mutations.ts`
// because `lib/categories.ts` (the pure field helpers) already owns that
// module specifier — a sibling directory would make `@/lib/categories`
// ambiguous to read.

export async function createCategoryForUser(
  userId: string,
  brandId: string,
  fields: CategoryFields,
): Promise<void> {
  validateCategoryFields(fields);
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("categories").insert({
    user_id: userId,
    brand_id: brandId,
    key: slugify(fields.name),
    name: fields.name,
    style_guide: fields.style_guide,
    output_format: fields.output_format,
    style_ref_url: fields.style_ref_url,
    post_caption: fields.post_caption,
    buffer_channel_id: fields.buffer_channel_id,
    buffer_connection_id: fields.buffer_connection_id || null,
    caption_guide: fields.caption_guide,
    buffer_channel_service: fields.buffer_channel_service,
    images_per_carousel: fields.images_per_carousel,
    post_type: fields.post_type,
    role_guides: fields.role_guides,
    aspect_ratio: fields.aspect_ratio || "4:5",
    active: fields.active,
  });
  if (error) {
    if (error.code === "23505") throw new Error("You already have a category with a similar name");
    throw new Error(error.message);
  }
}

export async function updateCategoryForUser(userId: string, id: string, fields: CategoryFields): Promise<void> {
  validateCategoryFields(fields);
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("categories").update({
    name: fields.name,
    style_guide: fields.style_guide,
    output_format: fields.output_format,
    style_ref_url: fields.style_ref_url,
    post_caption: fields.post_caption,
    buffer_channel_id: fields.buffer_channel_id,
    buffer_connection_id: fields.buffer_connection_id || null,
    caption_guide: fields.caption_guide,
    buffer_channel_service: fields.buffer_channel_service,
    images_per_carousel: fields.images_per_carousel,
    post_type: fields.post_type,
    role_guides: fields.role_guides,
    aspect_ratio: fields.aspect_ratio || "4:5",
    active: fields.active,
  }).eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// Correction surface for the manual editor: removes one promoted role ref
// so that role falls back to style_ref_url again (spec §10). Only this
// function and the promotion endpoint touch role_ref_urls — manual saves
// never do (CategoryFields deliberately excludes it).
export async function clearRoleRefUrlForUser(
  userId: string, categoryId: string, role: "hook" | "beat" | "payoff" | "single",
): Promise<void> {
  const supabase = createAdminSupabase();
  const { data: category } = await supabase
    .from("categories").select("role_ref_urls").eq("id", categoryId).eq("user_id", userId).maybeSingle();
  if (!category) throw new Error("unknown category");
  const next: RoleRefUrls = { ...(category.role_ref_urls ?? {}) };
  delete next[role];
  const { error } = await supabase.from("categories").update({ role_ref_urls: next })
    .eq("id", categoryId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function deleteCategoryForUser(userId: string, id: string): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("categories").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}
