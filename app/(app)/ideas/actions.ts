"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import { setIdeaDecisionForUser, createManualIdeaForUser } from "@/lib/idea-mutations";
import type { Slide } from "@/lib/types";

// Every export of a "use server" file is a public endpoint reachable by direct
// POST, so each action here authenticates first and then delegates to the
// userId-parameterized core in lib/idea-mutations.ts — which deliberately does
// NOT live in this file, because exporting it here would publish an
// unauthenticated, tenant-id-taking mutation as a callable server action.

export async function setIdeaDecision(id: string, decision: "approved" | "rejected") {
  const user = await requireUser();
  await setIdeaDecisionForUser(user.id, id, decision);
  revalidatePath("/ideas");
}

export async function createManualIdea(input: {
  categoryKey: string;
  concept: string;
  slides: Slide[];
  postText?: string;
}): Promise<void> {
  const user = await requireUser();
  await createManualIdeaForUser(user.id, input);
  revalidatePath("/ideas");
}
