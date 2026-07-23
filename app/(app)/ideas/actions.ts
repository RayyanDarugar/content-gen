"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";

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
