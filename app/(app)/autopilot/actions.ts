"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import {
  upsertWorkflowForUser, setWorkflowActiveForUser, type WorkflowSettings,
} from "@/lib/autopilot/workflow-mutations";

// Every export of a "use server" file is a public endpoint reachable by direct
// POST, so each action authenticates first and then delegates to the
// userId-parameterized core in lib/autopilot/workflow-mutations.ts — which
// deliberately does not live here.

export async function saveWorkflow(categoryId: string, settings: WorkflowSettings) {
  const user = await requireUser();
  await upsertWorkflowForUser(user.id, categoryId, settings);
  revalidatePath("/autopilot");
}

export async function setWorkflowActive(workflowId: string, active: boolean) {
  const user = await requireUser();
  await setWorkflowActiveForUser(user.id, workflowId, active);
  revalidatePath("/autopilot");
}

// "Turn on for every category" — the bulk action that makes setting up five
// categories one click instead of five. Each category is upserted with the
// same defaults; an existing workflow keeps its own rate only if the caller
// passes its current settings, so the UI sends per-category settings rather
// than assuming.
export async function saveWorkflows(
  entries: { categoryId: string; settings: WorkflowSettings }[],
) {
  const user = await requireUser();
  for (const e of entries) {
    await upsertWorkflowForUser(user.id, e.categoryId, e.settings);
  }
  revalidatePath("/autopilot");
}
