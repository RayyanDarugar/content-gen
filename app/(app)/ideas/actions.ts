"use server";
import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { validateSlideShape } from "@/lib/athena/slides";
import type { Slide } from "@/lib/types";

export async function setIdeaDecision(id: string, decision: "approved" | "rejected") {
  await requireUser();
  const supabase = await createServerSupabase();

  const { error } = await supabase
    .from("ideas")
    .update({ approved: decision === "approved", status: decision })
    .eq("id", id)
    .in("status", ["pending_review", "approved", "rejected"]); // never clobber in-flight rows
  if (error) throw new Error(error.message);
  revalidatePath("/ideas");
}

// The manual counterpart to generated carousels: same table, same generation
// path, same composer — only the author differs. Slide count is NOT clamped
// to the category's images_per_carousel; a hand-authored carousel may be any
// length. It skips pending_review because that queue exists to review the
// model's writing, and there is nothing to review about text just typed.
export async function createManualIdea(input: {
  categoryKey: string;
  concept: string;
  slides: Slide[];
}): Promise<void> {
  const user = await requireUser();
  const supabase = await createServerSupabase();

  const shape = validateSlideShape(input.slides, input.slides.length);
  if (!shape.ok) throw new Error(shape.reason);
  if (!input.concept.trim()) throw new Error("concept is required");

  const { data: category } = await supabase
    .from("categories").select("key").eq("key", input.categoryKey).maybeSingle();
  if (!category) throw new Error(`unknown category ${input.categoryKey}`);

  const { error } = await supabase.from("ideas").insert({
    user_id: user.id,
    category_key: input.categoryKey,
    concept: input.concept,
    resolved_prompt: "",
    ai_filter_reason: "",
    approved: true,
    status: "approved",
    batch_id: randomUUID(),
    slides: input.slides,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/ideas");
}
