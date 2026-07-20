"use server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";

export async function setIdeaDecision(id: string, decision: "approved" | "rejected") {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== process.env.ALLOWED_EMAIL) throw new Error("unauthorized");

  const { error } = await supabase
    .from("ideas")
    .update({ approved: decision === "approved", status: decision })
    .eq("id", id)
    .in("status", ["pending_review", "approved", "rejected"]); // never clobber in-flight rows
  if (error) throw new Error(error.message);
  revalidatePath("/ideas");
}
