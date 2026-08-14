import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { AutopilotPeriod, AutopilotRun, AutopilotWorkflow, Category } from "@/lib/types";

// Same rule as lib/overlay-mutations.ts: these take the tenant's userId and do
// NOT authenticate, so they must never be exported from a "use server" file —
// every export there is a publicly POST-reachable endpoint. The thin actions in
// app/(app)/autopilot/actions.ts call requireUser() and delegate here.

export interface WorkflowSettings {
  postsPerPeriod: number;
  period: AutopilotPeriod;
  timezone: string;
  maxAttemptsPerPeriod: number;
  autoPauseAfterFailedPeriods: number;
}

// Mirrors migration 0024's check constraints. Validating here turns a
// constraint violation into a readable message in the UI, and — for the
// timezone, which has no DB constraint — stops an unknown zone from throwing
// inside the cron on every tick at 3am.
export function validateWorkflowSettings(s: WorkflowSettings): void {
  if (!Number.isInteger(s.postsPerPeriod)) throw new Error("posts per period must be a whole number");
  if (s.postsPerPeriod < 1 || s.postsPerPeriod > 10) {
    throw new Error("posts per period must be between 1 and 10");
  }
  if (s.period !== "day" && s.period !== "week") throw new Error("period must be 'day' or 'week'");
  if (!Number.isInteger(s.maxAttemptsPerPeriod)) throw new Error("attempt cap must be a whole number");
  if (s.maxAttemptsPerPeriod < 1 || s.maxAttemptsPerPeriod > 10) {
    throw new Error("attempt cap must be between 1 and 10");
  }
  if (!Number.isInteger(s.autoPauseAfterFailedPeriods) || s.autoPauseAfterFailedPeriods < 1) {
    throw new Error("auto-pause threshold must be at least 1");
  }
  // No DB constraint covers this pair, but the combination can never meet
  // quota: one run is one post, so N posts need at least N attempts. Left
  // unchecked it would look like it was working, miss every period, and
  // auto-pause with "missed quota 3 periods running" — a message that says
  // nothing about the setting that made it impossible.
  if (s.postsPerPeriod > s.maxAttemptsPerPeriod) {
    throw new Error(
      `${s.postsPerPeriod} posts per period needs at least ${s.postsPerPeriod} attempts, ` +
      `but the attempt cap is ${s.maxAttemptsPerPeriod}`,
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone });
  } catch {
    throw new Error(`unknown timezone "${s.timezone}"`);
  }
}

export async function listWorkflowsForUser(
  userId: string,
  brandId: string,
): Promise<(AutopilotWorkflow & { category: Pick<Category, "id" | "key" | "name" | "active"> })[]> {
  const supabase = createAdminSupabase();
  // Two plain queries, joined in TypeScript — not a PostgREST embedded filter
  // (`categories!inner(...)` + `.eq("categories.brand_id", ...)`). There is no
  // precedent for that pattern in this codebase, and alias-vs-table-name in an
  // embedded filter is exactly the kind of thing that fails silently by
  // returning every row, which on a tenant-scoping path means one brand's
  // workflows leaking onto another brand's page.
  const { data: catsData, error: catsErr } = await supabase
    .from("categories")
    .select("id, key, name, active")
    .eq("user_id", userId)
    .eq("brand_id", brandId);
  if (catsErr) throw new Error(catsErr.message);
  const categories = (catsData ?? []) as Pick<Category, "id" | "key" | "name" | "active">[];
  if (!categories.length) return [];

  const { data: wfData, error: wfErr } = await supabase
    .from("autopilot_workflows")
    .select("*")
    .eq("user_id", userId)
    .in("category_id", categories.map((c) => c.id));
  if (wfErr) throw new Error(wfErr.message);
  const workflows = (wfData ?? []) as AutopilotWorkflow[];

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  return workflows.flatMap((w) => {
    const category = categoryById.get(w.category_id);
    // A workflow whose category isn't in this brand's set (or was deleted)
    // has no home on this page — drop it rather than return a broken row.
    return category ? [{ ...w, category }] : [];
  });
}

export async function upsertWorkflowForUser(
  userId: string,
  categoryId: string,
  settings: WorkflowSettings,
): Promise<void> {
  validateWorkflowSettings(settings);
  const supabase = createAdminSupabase();
  // categoryId arrives from the client and the admin client would happily
  // attach a workflow to another tenant's category. Same re-check, same
  // reasoning as createOverlayForUser.
  const { data: cat } = await supabase
    .from("categories").select("id").eq("id", categoryId).eq("user_id", userId).maybeSingle();
  if (!cat) throw new Error("unknown category");

  // Columns enumerated, never spread — a server action's arguments arrive as
  // JSON with the TypeScript shape erased, and a trailing spread would let a
  // caller-supplied user_id override the ownership established above.
  // Turning a workflow back on clears the pause: re-enabling something that
  // still reads "paused: missed quota" and still carries its failure counter
  // would auto-pause again after a single miss.
  const { error } = await supabase
    .from("autopilot_workflows")
    .upsert(
      {
        user_id: userId,
        category_id: categoryId,
        posts_per_period: settings.postsPerPeriod,
        period: settings.period,
        timezone: settings.timezone,
        max_attempts_per_period: settings.maxAttemptsPerPeriod,
        auto_pause_after_failed_periods: settings.autoPauseAfterFailedPeriods,
        active: true,
        paused_reason: "",
        consecutive_failed_periods: 0,
      },
      { onConflict: "category_id" },
    );
  if (error) throw new Error(error.message);
}

export async function setWorkflowActiveForUser(
  userId: string,
  workflowId: string,
  active: boolean,
): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from("autopilot_workflows")
    .update(
      active
        ? { active: true, paused_reason: "", consecutive_failed_periods: 0 }
        : { active: false, paused_reason: "turned off by hand" },
    )
    .eq("id", workflowId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function listRecentRunsForUser(
  userId: string,
  brandId: string,
  limit = 20,
): Promise<AutopilotRun[]> {
  const supabase = createAdminSupabase();
  const workflows = await listWorkflowsForUser(userId, brandId);
  if (!workflows.length) return [];
  const { data, error } = await supabase
    .from("autopilot_runs")
    .select("*")
    .eq("user_id", userId)
    .in("workflow_id", workflows.map((w) => w.id))
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as AutopilotRun[];
}
