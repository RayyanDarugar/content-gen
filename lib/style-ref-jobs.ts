import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadBrandContext } from "@/lib/athena/brand-context";
import { buildStyleRefPrompt } from "@/lib/athena/style-ref-prompt";
import { createTextToImageKieTask } from "@/lib/athena/kie";
import { requireKieKey } from "@/lib/settings/user-secrets";
import type { Category, StyleRefJob } from "@/lib/types";

// *ForUser: caller must already have authenticated userId (the MCP route's
// bearer-token auth) — same pattern as lib/category-mutations.ts. Not a
// "use server" module for the same reason documented there: every export of
// one is a public, directly callable endpoint, which would turn an
// unauthenticated submitStyleRefJobForUser(otherTenantId, categoryId) into
// exactly that.

// Submits a Kie text-to-image task and returns immediately — never polls,
// never waits on Kie. The job row is what lets the cron poller
// (app/api/jobs/poll/route.ts) finish this later.
export async function submitStyleRefJobForUser(
  userId: string,
  categoryId: string,
  notes?: string,
): Promise<{ jobId: string }> {
  const supabase = createAdminSupabase();
  // Filtered by BOTH id and user_id — never id alone. This is the only
  // thing standing between an authenticated MCP caller and generating (and,
  // once the job succeeds, persisting) an image against another tenant's
  // category.
  const { data: categoryRow, error: categoryErr } = await supabase
    .from("categories").select("*").eq("id", categoryId).eq("user_id", userId).maybeSingle();
  if (categoryErr) throw new Error(categoryErr.message);
  if (!categoryRow) throw new Error(`unknown category ${categoryId}`);
  const category = categoryRow as Category;

  const brand = await loadBrandContext(userId);
  const kieKey = await requireKieKey(userId);
  const prompt = buildStyleRefPrompt(brand, notes);
  const kieTaskId = await createTextToImageKieTask(kieKey, prompt, category.aspect_ratio);

  const { data: jobRow, error: insertErr } = await supabase
    .from("style_ref_jobs")
    .insert({ user_id: userId, category_id: categoryId, kie_task_id: kieTaskId })
    .select("id")
    .single();
  if (insertErr) throw new Error(insertErr.message);

  return { jobId: jobRow.id as string };
}

export async function getStyleRefJobForUser(
  userId: string,
  jobId: string,
): Promise<{ status: string; error: string; styleRefUrl: string }> {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("style_ref_jobs").select("*").eq("id", jobId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`unknown style ref job ${jobId}`);
  const job = data as StyleRefJob;
  return { status: job.status, error: job.error, styleRefUrl: job.style_ref_url };
}
