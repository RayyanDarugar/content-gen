import Link from "next/link";
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

type LiveRunRow = { state: string; attempt_no: number; period_start: string };

// A `succeeded` run carrying an `error` is the partial multi-channel case
// (spec §6): one channel queued, another was rejected. The quota counted it
// and autopilot deliberately does not retry the failed channel, so it must
// read as a WARNING — rendering it the same way as a failed run tells a human
// nothing went out when something did.
function outcomeOf(run: AutopilotRun): { text: string; className: string } {
  if (run.state === "failed") {
    return { text: run.error || "failed", className: "text-destructive" };
  }
  if (run.state === "succeeded" && run.error) {
    return { text: `warning: ${run.error}`, className: "text-amber-600 dark:text-amber-500" };
  }
  return { text: run.state.replaceAll("_", " "), className: "text-muted-foreground" };
}

function RunRow({ run }: { run: AutopilotRun }) {
  const outcome = outcomeOf(run);
  const steps = run.steps ?? [];
  return (
    <div className="space-y-1.5 rounded-xl border p-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs text-muted-foreground">
          {run.period_start} · attempt {run.attempt_no}
        </span>
        <span className="truncate">{run.category_key}</span>
        {run.source && <Badge variant="outline">{run.source.replaceAll("_", " ")}</Badge>}
        <span className={`ml-auto shrink-0 truncate text-xs ${outcome.className}`}>
          {outcome.text}
        </span>
      </div>
      {/* Spec §8 asks the feed to say WHAT happened, not only where it
          stopped. This is the only reader of `steps`, which six call sites in
          the tick write — without it the column is write-only. */}
      {steps.length > 0 && (
        <ol className="space-y-0.5 text-xs text-muted-foreground">
          {steps.map((s, i) => (
            <li key={`${s.at}-${i}`} className="truncate">
              <span className="font-medium">{s.step}</span> · {s.detail}
            </li>
          ))}
        </ol>
      )}
      {(run.idea_id || run.post_group_id) && (
        <div className="flex gap-3 text-xs">
          {run.idea_id && (
            <Link href={`/post/${run.idea_id}`} className="text-primary hover:underline">
              open the idea
            </Link>
          )}
          {/* There is no post-group-scoped route in this app, so the group's
              home is the schedule — the only surface that lists posts. The id
              is shown so it can be matched there (and in Buffer) by eye. */}
          {run.post_group_id && (
            <Link href="/schedule" className="text-primary hover:underline">
              post group {run.post_group_id.slice(0, 8)}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

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
          attemptsUsed: 0, maxAttempts: 3, currentPeriod: "", live: null,
        }),
      };
    }
    const period = periodStart(now, wf.timezone, wf.period);
    const from = periodStartUtc(period, wf.timezone).toISOString();
    const { data: postRows } = await supabase
      .from("posts").select("post_group_id")
      .eq("category_key", c.key).neq("status", "failed").gte("created_at", from);
    const landed = new Set((postRows ?? []).map((r) => (r as { post_group_id: string }).post_group_id)).size;
    // Both facts come straight from autopilot_runs for THIS workflow, never
    // from the recent-runs feed below. That feed is a fixed display budget
    // shared by every category, so a busy brand can push a workflow's own
    // attempts out of it — and a workflow that has exhausted its cap would
    // then read "attempt 2 of 3" instead of "gave up for this period", which
    // is exactly the false "still working" this page exists to prevent.
    //
    // TWO queries, because the two facts have different scopes:
    //
    //  - The attempt count is genuinely per-period: max_attempts_per_period
    //    resets at every rollover, so counting anything else would misreport
    //    how much budget is left.
    //  - The live run is NOT. runAutopilotTick's own live-run query
    //    (lib/autopilot/tick.ts) has no period filter by design: a run opened
    //    just before a rollover stays live across it and keeps being advanced
    //    — up to and including a Buffer post. Filtering by period here would
    //    show "waiting to start (0/1 posted)" for a workflow the tick is
    //    actively spending on. Ordered oldest-first and limited to one so the
    //    run picked is the same one the tick advances, and it carries its own
    //    attempt_no and period_start so a straggler reads honestly.
    const { count: attemptCount } = await supabase
      .from("autopilot_runs")
      .select("id", { count: "exact", head: true })
      .eq("workflow_id", wf.id)
      .eq("period_start", period);
    const { data: liveRows } = await supabase
      .from("autopilot_runs")
      .select("state, attempt_no, period_start")
      .eq("workflow_id", wf.id)
      .in("state", LIVE_STATES)
      .order("created_at", { ascending: true })
      .limit(1);
    const liveRun = ((liveRows ?? []) as LiveRunRow[])[0] ?? null;
    return {
      categoryId: c.id, categoryName: c.name, workflowId: wf.id, active: wf.active,
      postsPerPeriod: wf.posts_per_period, period: wf.period, timezone: wf.timezone,
      status: describeWorkflowStatus({
        active: wf.active, pausedReason: wf.paused_reason,
        postsPerPeriod: wf.posts_per_period, landedGroups: landed,
        attemptsUsed: attemptCount ?? 0,
        maxAttempts: wf.max_attempts_per_period,
        currentPeriod: period,
        live: liveRun
          ? {
              state: liveRun.state,
              attemptNo: liveRun.attempt_no,
              periodStart: liveRun.period_start,
            }
          : null,
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
        {runs.map((run: AutopilotRun) => <RunRow key={run.id} run={run} />)}
      </section>
    </div>
  );
}
