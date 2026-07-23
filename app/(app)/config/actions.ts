"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { encryptSecret } from "@/lib/crypto/secrets";

export interface CategoryUpdate {
  name: string;
  style_guide: string;
  style_ref_url: string;
  post_caption: string;
  buffer_channel_id: string;
  buffer_account: number;
  images_per_carousel: number;
  aspect_ratio: string;
  active: boolean;
}

export async function updateCategory(key: string, fields: CategoryUpdate) {
  await requireUser();
  const supabase = await createServerSupabase();
  if (![1, 2].includes(fields.buffer_account)) throw new Error("buffer_account must be 1 or 2");
  if (!Number.isInteger(fields.images_per_carousel) || fields.images_per_carousel < 1 || fields.images_per_carousel > 10) {
    throw new Error("images_per_carousel must be 1-10");
  }
  const { error } = await supabase.from("categories").update(fields).eq("key", key);
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
