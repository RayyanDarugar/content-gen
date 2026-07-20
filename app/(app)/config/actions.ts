"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAllowedUser } from "@/lib/auth/require-user";

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
  await requireAllowedUser();
  const supabase = await createServerSupabase();
  if (![1, 2].includes(fields.buffer_account)) throw new Error("buffer_account must be 1 or 2");
  if (!Number.isInteger(fields.images_per_carousel) || fields.images_per_carousel < 1 || fields.images_per_carousel > 10) {
    throw new Error("images_per_carousel must be 1-10");
  }
  const { error } = await supabase.from("categories").update(fields).eq("key", key);
  if (error) throw new Error(error.message);
  revalidatePath("/config");
}
