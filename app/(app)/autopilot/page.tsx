import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { createServerSupabase } from "@/lib/supabase/server";
import { listWorkflowsForUser, listRecentRunsForUser } from "@/lib/autopilot/workflow-mutations";
import { describeWorkflowStatus } from "@/lib/autopilot/status";
import { periodStart, periodStartUtc } from "@/lib/autopilot/period";
import { WorkflowRow, type RowProps } from "./workflow-row";
import { TurnOnAll } from "./turn-on-all";
import { Badge } from "@/components/ui/badge";
import type { AutopilotRun } from "@/lib/types";

export const dynamic = "force-dynamic";

// Every AutopilotRunState a run can still be working in — `publishing`
// included, since that is the claim state a run holds while Buffer is being
// called and a page loaded mid-post would otherwise show it as idle.
const LIVE_STATES = ["sourcing", "awaiting_images", "posting", "publishing"];

export default async function AutopilotPage() {
  const user = await requireUser();
  // requireActiveBrand, not getActiveBrand: it redirects to /onboarding when
  // there is no brand, which is what every other page here does.
  const brand = await requireActiveBrand(user.id);

  // The RLS-scoped server client, like app/(app)/schedule/page.tsx — this page
  // reads only its own reader's rows, so no admin client and no hand-written
  // user_id predicate. The lib helpers below take the admin client and do
  // their own explicit scoping.
  const supabase = await createServerSupabase();
  const { data: catData } = await supabase
    .from("categories").select("id, key, name")
    .eq("brand_id", brand.id).eq("active", true).order("name");
  const categories = (catData ?? []) as { id: string; key: string; name: string }[];

  const workflows = await listWorkflowsForUser(user.id, brand.id);
  const byCategory = new Map(workflows.map((w) => [w.category_id, w]));
  const runs = await listRecentRunsForUser(user.id, brand.id, 20);
  const now = new Date();

  const rows: RowProps[] = await Promise.all(categories.map(async (c) => {
    const wf = byCategory.get(c.id);
    if (!wf) {
      return {
        categoryId: c.id, categoryName: c.name, workflowId: null, active: false,
        postsPerPeriod: 1, period: "day" as const, timezone: "",
        status: describeWorkflowStatus({
          active: false, pausedReason: "", postsPerPeriod: 1, landedGroups: 0,
          attemptsUsed: 0, maxAttempts: 3, liveState: null,
        }),
      };
    }
    const period = periodStart(now, wf.timezone, wf.period);
    const from = periodStartUtc(period, wf.timezone).toISOString();
    const { data: postRows } = await supabase
      .from("posts").select("post_group_id")
      .eq("category_key", c.key).neq("status", "failed").gte("created_at", from);
    const landed = new Set((postRows ?? []).map((r) => (r as { post_group_id: string }).post_group_id)).size;
    const periodRuns = runs.filter((r) => r.workflow_id === wf.id && r.period_start === period);
    return {
      categoryId: c.id, categoryName: c.name, workflowId: wf.id, active: wf.active,
      postsPerPeriod: wf.posts_per_period, period: wf.period, timezone: wf.timezone,
      status: describeWorkflowStatus({
        active: wf.active, pausedReason: wf.paused_reason,
        postsPerPeriod: wf.posts_per_period, landedGroups: landed,
        attemptsUsed: periodRuns.length, maxAttempts: wf.max_attempts_per_period,
        liveState: periodRuns.find((r) => LIVE_STATES.includes(r.state))?.state ?? null,
      }),
    };
  }));

  // Only the categories with nothing set up yet — see TurnOnAll for why the
  // bulk action deliberately leaves existing workflows alone.
  const unconfigured = rows.filter((r) => !r.workflowId).map((r) => r.categoryId);

  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-2">
        <h1 className="text-lg font-semibold">Autopilot</h1>
        <p className="text-sm text-muted-foreground">
          A category on autopilot publishes on its own — ideas, images, and the post.
          Timing is Buffer&apos;s queue, not this page.
        </p>
        <TurnOnAll categoryIds={unconfigured} />
        <div className="space-y-2">
          {rows.map((r) => <WorkflowRow key={r.categoryId} {...r} />)}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Recent runs</h2>
        {runs.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing has run yet.</p>
        )}
        {runs.map((run: AutopilotRun) => (
          <div key={run.id} className="flex items-center gap-3 rounded-xl border p-3 text-sm">
            <span className="shrink-0 text-xs text-muted-foreground">
              {run.period_start} · attempt {run.attempt_no}
            </span>
            <span className="truncate">{run.category_key}</span>
            {run.source && <Badge variant="outline">{run.source.replace("_", " ")}</Badge>}
            <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
              {run.error || run.state}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
