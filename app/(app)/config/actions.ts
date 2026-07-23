"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { encryptSecret } from "@/lib/crypto/secrets";
import { uploadImageToCloudinary } from "@/lib/cloudinary";

export interface CategoryFields {
  name: string;
  style_guide: string;
  output_format: string;
  style_ref_url: string;
  images_per_carousel: number;
  aspect_ratio: string;
  active: boolean;
}

function validateFields(f: CategoryFields) {
  if (!f.name.trim()) throw new Error("Name is required");
  if (!Number.isInteger(f.images_per_carousel) || f.images_per_carousel < 1 || f.images_per_carousel > 10) {
    throw new Error("images_per_carousel must be 1-10");
  }
}

function slugify(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "CATEGORY";
}

export async function createCategory(fields: CategoryFields) {
  const user = await requireUser();
  validateFields(fields);
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("categories").insert({
    user_id: user.id,
    key: slugify(fields.name),
    name: fields.name,
    style_guide: fields.style_guide,
    output_format: fields.output_format,
    style_ref_url: fields.style_ref_url,
    images_per_carousel: fields.images_per_carousel,
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
  validateFields(fields);
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("categories").update({
    name: fields.name,
    style_guide: fields.style_guide,
    output_format: fields.output_format,
    style_ref_url: fields.style_ref_url,
    images_per_carousel: fields.images_per_carousel,
    aspect_ratio: fields.aspect_ratio || "4:5",
    active: fields.active,
  }).eq("id", id);
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
