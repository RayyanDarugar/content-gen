"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { encryptSecret } from "@/lib/crypto/secrets";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import { storeBufferToken, disconnectBuffer } from "@/lib/settings/buffer";
import { type CategoryFields, validateCategoryFields, slugify } from "@/lib/categories";
import type { RoleRefUrls } from "@/lib/types";

export async function createCategory(fields: CategoryFields) {
  const user = await requireUser();
  validateCategoryFields(fields);
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("categories").insert({
    user_id: user.id,
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
  revalidatePath("/config");
}

export async function updateCategory(id: string, fields: CategoryFields) {
  await requireUser();
  validateCategoryFields(fields);
  const supabase = await createServerSupabase();
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
  }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/config");
}

// Correction surface for the manual editor: removes one promoted role ref
// so that role falls back to style_ref_url again (spec §10). Only this
// action and the promotion endpoint touch role_ref_urls — manual saves
// never do (CategoryFields deliberately excludes it).
export async function clearRoleRefUrl(categoryId: string, role: "hook" | "beat" | "payoff" | "single") {
  await requireUser();
  const supabase = await createServerSupabase();
  const { data: category } = await supabase
    .from("categories").select("role_ref_urls").eq("id", categoryId).maybeSingle();
  if (!category) throw new Error("unknown category");
  const next: RoleRefUrls = { ...(category.role_ref_urls ?? {}) };
  delete next[role];
  const { error } = await supabase.from("categories").update({ role_ref_urls: next }).eq("id", categoryId);
  if (error) throw new Error(error.message);
  revalidatePath("/config");
}

export async function deleteCategory(id: string) {
  await requireUser();
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/config");
}

export async function saveApiKeys(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  const supabase = await createServerSupabase();
  const anthropic = String(formData.get("anthropic") ?? "").trim();
  const kie = String(formData.get("kie") ?? "").trim();

  // Only overwrite a key when a new value was typed (blank = leave unchanged).
  const patch: Record<string, string> = { user_id: user.id };
  if (anthropic) patch.anthropic_key_enc = encryptSecret(anthropic);
  if (kie) patch.kie_key_enc = encryptSecret(kie);

  const { error } = await supabase.from("user_settings").upsert(patch, { onConflict: "user_id" });
  if (error) return { error: error.message };
  revalidatePath("/config");
  return { ok: true };
}

export async function uploadStyleRefImage(
  formData: FormData,
): Promise<{ url?: string; error?: string }> {
  await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "No file provided" };
  if (file.size > 10 * 1024 * 1024) return { error: "Image must be under 10MB" };
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const { url } = await uploadImageToCloudinary(buffer, file.type || "image/jpeg");
    return { url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveBrandProfile(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("brand_profiles").upsert(
    {
      user_id: user.id,
      business_name: String(formData.get("business_name") ?? "").trim(),
      business_description: String(formData.get("business_description") ?? "").trim(),
      audience: String(formData.get("audience") ?? "").trim(),
      voice: String(formData.get("voice") ?? "").trim(),
      avoid: String(formData.get("avoid") ?? "").trim(),
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };
  revalidatePath("/config");
  return { ok: true };
}

export async function saveBufferToken(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  const token = String(formData.get("token") ?? "").trim();
  if (!token) return { error: "Enter a Buffer personal key." };
  try {
    await storeBufferToken(user.id, token);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/config");
  return { ok: true };
}

export async function disconnectBufferAction() {
  const user = await requireUser();
  await disconnectBuffer(user.id);
  revalidatePath("/config");
}
