"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { encryptSecret } from "@/lib/crypto/secrets";
import { uploadImageToCloudinary, uploadDocumentToCloudinary } from "@/lib/cloudinary";
import { addBufferConnection, removeBufferConnection } from "@/lib/settings/buffer";
import { type CategoryFields } from "@/lib/categories";
import { parseBrandList } from "@/lib/brand";
import { createApiTokenForUser, listApiTokensForUser, revokeApiTokenForUser } from "@/lib/auth/api-tokens";
import {
  createCategoryForUser,
  updateCategoryForUser,
  clearRoleRefUrlForUser,
  deleteCategoryForUser,
} from "@/lib/category-mutations";
import {
  createOverlayForUser, updateOverlayForUser, deleteOverlayForUser,
} from "@/lib/overlay-mutations";
import type { OverlayFields } from "@/lib/overlays";
import { saveBrandProfileForUser, createBrandForUser } from "@/lib/brand-profile";
import { setActiveBrand } from "@/app/(app)/brand-actions";

// Everything exported from this file is a "use server" action — i.e. a public
// endpoint reachable by direct POST. Every export below therefore starts with
// requireUser(); the userId-parameterized cores they delegate to deliberately
// live in plain lib/ modules (lib/category-mutations.ts, lib/brand-profile.ts)
// so they are NOT published as actions of their own.

export async function createCategory(fields: CategoryFields) {
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  await createCategoryForUser(user.id, brand.id, fields);
  revalidatePath("/config");
}

export async function updateCategory(id: string, fields: CategoryFields) {
  const user = await requireUser();
  await updateCategoryForUser(user.id, id, fields);
  revalidatePath("/config");
}

// Correction surface for the manual editor: removes one promoted role ref
// so that role falls back to style_ref_url again (spec §10). Only this
// action and the promotion endpoint touch role_ref_urls — manual saves
// never do (CategoryFields deliberately excludes it).
export async function clearRoleRefUrl(categoryId: string, role: "hook" | "beat" | "payoff" | "single") {
  const user = await requireUser();
  await clearRoleRefUrlForUser(user.id, categoryId, role);
  revalidatePath("/config");
}

export async function deleteCategory(id: string) {
  const user = await requireUser();
  await deleteCategoryForUser(user.id, id);
  revalidatePath("/config");
}

export async function createOverlay(categoryId: string, fields: OverlayFields) {
  const user = await requireUser();
  await createOverlayForUser(user.id, categoryId, fields);
  revalidatePath("/config");
}

export async function updateOverlay(id: string, fields: OverlayFields) {
  const user = await requireUser();
  await updateOverlayForUser(user.id, id, fields);
  revalidatePath("/config");
}

export async function deleteOverlay(id: string) {
  const user = await requireUser();
  await deleteOverlayForUser(user.id, id);
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

// Sibling of uploadStyleRefImage, deliberately NOT reusing it: that action
// posts to Cloudinary's /image/upload endpoint, which is unreliable for PDF
// documents (see uploadDocumentToCloudinary's comment). Brand-extraction
// documents (pitch decks, one-pagers) go through /raw/upload instead so the
// content-type the extraction endpoint's preflight reads back is trustworthy.
export async function uploadBrandDocument(
  formData: FormData,
): Promise<{ url?: string; error?: string }> {
  await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "No file provided" };
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const isImage = file.type.startsWith("image/");
  if (!isPdf && !isImage) return { error: "Only PDF or image documents are supported" };
  if (file.size > 20 * 1024 * 1024) return { error: "Document must be under 20MB" };
  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = file.type || (isPdf ? "application/pdf" : "application/octet-stream");
  try {
    const { url } = await uploadDocumentToCloudinary(buffer, mime, file.name);
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
  const brand = await requireActiveBrand(user.id);
  try {
    await saveBrandProfileForUser(user.id, brand.id, {
      business_name: String(formData.get("business_name") ?? "").trim(),
      business_description: String(formData.get("business_description") ?? "").trim(),
      audience: String(formData.get("audience") ?? "").trim(),
      voice: String(formData.get("voice") ?? "").trim(),
      avoid: String(formData.get("avoid") ?? "").trim(),
      proof_points: parseBrandList(formData.get("proof_points")),
      standing: parseBrandList(formData.get("standing")),
      colors: parseBrandList(formData.get("colors")),
      fonts: parseBrandList(formData.get("fonts")),
      visual_notes: String(formData.get("visual_notes") ?? "").trim(),
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/config");
  return { ok: true };
}

// Creating a brand and switching to it are one user intent: a new brand the
// user is not looking at is a confusing outcome.
export async function createBrandAction(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  try {
    const brandId = await createBrandForUser(user.id, {
      business_name: String(formData.get("business_name") ?? "").trim(),
      business_description: String(formData.get("business_description") ?? "").trim(),
      audience: String(formData.get("audience") ?? "").trim(),
      voice: String(formData.get("voice") ?? "").trim(),
      avoid: String(formData.get("avoid") ?? "").trim(),
      proof_points: parseBrandList(formData.get("proof_points")),
      standing: parseBrandList(formData.get("standing")),
      colors: parseBrandList(formData.get("colors")),
      fonts: parseBrandList(formData.get("fonts")),
      visual_notes: String(formData.get("visual_notes") ?? "").trim(),
    });
    await setActiveBrand(brandId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/config");
  return { ok: true };
}

export async function addBufferConnectionAction(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  const label = String(formData.get("label") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();
  if (!label) return { error: "Name this connection (e.g. the account it belongs to)." };
  if (!token) return { error: "Paste the Buffer personal key." };
  try {
    await addBufferConnection(user.id, label, token);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/config");
  return { ok: true };
}

export async function removeBufferConnectionAction(connectionId: string) {
  const user = await requireUser();
  await removeBufferConnection(user.id, connectionId);
  revalidatePath("/config");
}

// Formats are always written as origin 'observed' from this surface —
// 'invented' rows are only ever created by suggestion writeback. shared is
// never set here: promoting a format is a manual step in Supabase, and RLS
// enforces that independently of this action.
export async function saveFormat(
  formData: FormData,
): Promise<{ error?: string }> {
  const user = await requireUser();
  const supabase = await createServerSupabase();

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const structure = String(formData.get("structure") ?? "").trim();
  if (!name) return { error: "Name is required" };
  if (!structure) return { error: "Structure is required" };

  const fields = {
    name,
    structure,
    why_it_works: String(formData.get("why_it_works") ?? "").trim(),
    source_example: String(formData.get("source_example") ?? "").trim(),
    brand_fit: String(formData.get("brand_fit") ?? "").trim(),
    screenshot_url: String(formData.get("screenshot_url") ?? "").trim(),
    active: formData.get("active") === "on",
  };

  const { error } = id
    ? await supabase.from("formats").update(fields).eq("id", id)
    : await supabase.from("formats").insert({
        ...fields, user_id: user.id, origin: "observed", shared: false,
      });
  if (error) return { error: error.message };

  revalidatePath("/config/formats");
  return {};
}

export async function deleteFormat(id: string): Promise<{ error?: string }> {
  await requireUser();
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("formats").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/config/formats");
  return {};
}

export async function createApiToken(label: string): Promise<{ token?: string; error?: string }> {
  const user = await requireUser();
  try {
    const { token } = await createApiTokenForUser(user.id, label);
    revalidatePath("/config");
    return { token };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listApiTokens() {
  const user = await requireUser();
  return listApiTokensForUser(user.id);
}

export async function revokeApiToken(tokenId: string): Promise<void> {
  const user = await requireUser();
  await revokeApiTokenForUser(user.id, tokenId);
  revalidatePath("/config");
}
