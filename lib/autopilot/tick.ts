import "server-only";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { generateIdeas } from "@/lib/athena/generate-ideas";
import { submitGenerations } from "@/lib/athena/submit-generations";
import { scheduleValidatedPost } from "@/app/api/posts/create/route";
import { resolveValidSlides, type SiblingGeneration } from "@/lib/athena/carousel";
import { periodStart, periodStartUtc } from "@/lib/autopilot/period";
import { quotaGap, settlePeriod } from "@/lib/autopilot/quota";
import { selectSource, IDEA_BATCH, type IdeaCandidate } from "@/lib/autopilot/sourcing";
import { decideAwaitingImages } from "@/lib/autopilot/run-step";
import type {
  AutopilotRun, AutopilotRunState, AutopilotRunStep, AutopilotSource,
  AutopilotWorkflow, Category, Idea,
} from "@/lib/types";

// How many workflows one tick looks at. At a 5-minute cadence this is far more
// than any single tenant needs, and it bounds the tick's DB work.
export const WORKFLOW_TICK_CAP = 20;
// How many ideas are considered as sourcing candidates per workflow.
const CANDIDATE_LIMIT = 50;

// Every state a run can be live in — `publishing` included, so a run abandoned
// mid-post by a crash is picked up rather than sitting live forever and
// blocking the workflow's next attempt. Picked up to be RESOLVED, never
// re-posted: see resolvePublishingRun.
const LIVE_STATES = ["sourcing", "awaiting_images", "posting", "publishing"];

// The route's maxDuration is 120s. Being killed mid-loop is what manufactures
// an abandoned `publishing` run in the first place — a tick cut off between
// Buffer's response and the terminal write leaves a carousel published that
// nothing in this database records — so the sweep stops itself well short of
// the platform's own axe. Rotation via last_ticked_at makes an early break
// harmless: the workflows not reached keep their place at the front.
const SWEEP_BUDGET_MS = 90_000;
// Separately and much earlier, the app-wide tier-4 slot is withdrawn.
// generateIdeas makes two Anthropic calls with thinking and no per-call
// timeout override (the SDK default is 10 minutes), and the spec budgets ~90s
// for it. Past this mark, starting one could run the clock out over a Buffer
// post that another workflow is about to make.
const IDEA_GENERATION_CUTOFF_MS = 20_000;

export interface TickSummary {
  workflowsExamined: number;
  runsOpened: number;
  runsAdvanced: number;
  // True when the sweep broke on its wall-clock budget rather than running out
  // of workflows. Surfaced so a tick that is chronically running out of time
  // is visible in the cron's own response body instead of being inferred.
  stoppedEarly: boolean;
  errors: string[];
}

type WorkflowRow = AutopilotWorkflow & { category: Category | null };

export async function runAutopilotTick(now: Date = new Date()): Promise<TickSummary> {
  const supabase = createAdminSupabase();
  const startedAt = Date.now();
  const summary: TickSummary = {
    workflowsExamined: 0, runsOpened: 0, runsAdvanced: 0, stoppedEarly: false, errors: [],
  };

  // The one query with no tenant predicate, and deliberately so: this is the
  // app-wide sweep that finds which tenants have work. Everything below it is
  // scoped to the user_id of the row it came from.
  //
  // Ordered by last_ticked_at (nulls — never ticked — first), NOT by
  // created_at: the cap is app-wide, and a static ordering would examine the
  // same oldest WORKFLOW_TICK_CAP workflows on every tick and starve the tail
  // permanently — never settled, never posted, and silent about it. Rotating
  // makes the cap a throughput limit instead of a cliff. created_at breaks
  // ties so the order is deterministic.
  const { data, error } = await supabase
    .from("autopilot_workflows")
    .select("*, category:categories(*)")
    .eq("active", true)
    .order("last_ticked_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(WORKFLOW_TICK_CAP);
  if (error) throw new Error(`workflow query failed: ${error.message}`);

  // One idea-generation call per tick, app-wide (spec §5): it makes two
  // Anthropic calls and can take ~90s of this route's 120s budget. Whoever
  // takes the slot moves to awaiting_images and stops competing for it, so
  // deferred workflows win it on later ticks without any explicit fairness
  // bookkeeping.
  const budget = { ideaGenerations: 1 };

  for (const row of (data ?? []) as WorkflowRow[]) {
    // Checked BEFORE stampTicked, so a workflow the sweep never got to keeps
    // its null/oldest last_ticked_at and is first in line on the next tick.
    if (Date.now() - startedAt >= SWEEP_BUDGET_MS) {
      summary.stoppedEarly = true;
      break;
    }
    const { category, ...workflow } = row;
    try {
      // Stamped for EVERY row the sweep examined, before the inactive-category
      // skip and before any work — otherwise a workflow that is always
      // skipped, or always throws, would keep its place at the front of the
      // ordering and consume a slot on every tick, which is the starvation
      // this ordering exists to prevent. Inside the try like everything else
      // in this loop: it is an await, and an await with no net under it can
      // abort the whole sweep.
      await stampTicked(supabase, workflow, now);
      if (!category?.active) continue;
      summary.workflowsExamined++;
      if (Date.now() - startedAt >= IDEA_GENERATION_CUTOFF_MS) budget.ideaGenerations = 0;
      await tickWorkflow(supabase, workflow, category, now, budget, summary);
    } catch (e) {
      // One tenant's broken workflow must never stop the sweep.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`autopilot: workflow ${workflow.id} failed:`, message);
      summary.errors.push(`${workflow.id.slice(0, 8)}: ${message}`);
    }
  }
  return summary;
}

// Best-effort by design: a failed stamp costs this workflow its turn at the
// front of the queue next tick, which is not worth aborting real work over.
async function stampTicked(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  now: Date,
): Promise<void> {
  const { error } = await supabase
    .from("autopilot_workflows")
    .update({ last_ticked_at: now.toISOString() })
    .eq("id", workflow.id)
    .eq("user_id", workflow.user_id);
  if (error) console.error(`autopilot: stamping workflow ${workflow.id} failed:`, error.message);
}

async function tickWorkflow(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  now: Date,
  budget: { ideaGenerations: number },
  summary: TickSummary,
): Promise<void> {
  const period = periodStart(now, workflow.timezone, workflow.period);

  // 1. Settle the period that just ended, exactly once per rollover.
  if (workflow.last_settled_period !== period) {
    const priorLanded = workflow.last_settled_period
      ? await countLandedGroups(
          supabase, workflow, category.key, workflow.last_settled_period, period,
        )
      : 0;
    const decision = settlePeriod({
      lastSettledPeriod: workflow.last_settled_period,
      currentPeriod: period,
      priorLandedGroups: priorLanded,
      postsPerPeriod: workflow.posts_per_period,
      consecutiveFailedPeriods: workflow.consecutive_failed_periods,
      autoPauseAfterFailedPeriods: workflow.auto_pause_after_failed_periods,
      lastError: await lastErrorForPeriod(supabase, workflow, workflow.last_settled_period),
    });
    if (decision.action === "settle") {
      const { error } = await supabase
        .from("autopilot_workflows")
        .update({
          consecutive_failed_periods: decision.consecutiveFailedPeriods,
          active: decision.active,
          paused_reason: decision.pausedReason,
          last_settled_period: decision.lastSettledPeriod,
        })
        .eq("id", workflow.id)
        .eq("user_id", workflow.user_id);
      if (error) throw new Error(`settle failed: ${error.message}`);
      if (!decision.active) return;
    }
  }

  // 2. A live run gets advanced; a workflow never has two at once.
  const { data: liveData, error: liveErr } = await supabase
    .from("autopilot_runs")
    .select("*")
    .eq("workflow_id", workflow.id)
    .eq("user_id", workflow.user_id)
    .in("state", LIVE_STATES)
    .order("created_at", { ascending: true })
    .limit(1);
  if (liveErr) throw new Error(`live-run query failed: ${liveErr.message}`);
  const live = ((liveData ?? []) as AutopilotRun[])[0];
  if (live) {
    await advanceRun(supabase, workflow, category, live, now, budget);
    summary.runsAdvanced++;
    return;
  }

  // 3. Measure the gap for the open period.
  const landed = await countLandedGroups(supabase, workflow, category.key, period);
  const { count, error: countErr } = await supabase
    .from("autopilot_runs")
    .select("*", { count: "exact", head: true })
    .eq("workflow_id", workflow.id)
    .eq("user_id", workflow.user_id)
    .eq("period_start", period);
  if (countErr) throw new Error(`attempt count failed: ${countErr.message}`);
  const gap = quotaGap({
    landedGroups: landed,
    postsPerPeriod: workflow.posts_per_period,
    attemptsUsed: count ?? 0,
    maxAttempts: workflow.max_attempts_per_period,
  });
  if (gap.action !== "open") return;

  // 4. Open the attempt and advance it now, rather than idling until the next
  // tick — the whole point of a 5-minute cadence is that a run makes progress
  // the moment it exists.
  const { data: created, error: insErr } = await supabase
    .from("autopilot_runs")
    .insert({
      user_id: workflow.user_id,
      workflow_id: workflow.id,
      category_key: category.key,
      period_start: period,
      attempt_no: gap.attemptNo,
      state: "sourcing",
    })
    .select()
    .single();
  if (insErr) {
    // unique (workflow_id, period_start, attempt_no) — an overlapping tick
    // already opened this attempt and is advancing it. Leave it alone.
    if ((insErr as { code?: string }).code === "23505") return;
    throw new Error(`run insert failed: ${insErr.message}`);
  }
  summary.runsOpened++;
  await advanceRun(supabase, workflow, category, created as AutopilotRun, now, budget);
}

// Distinct non-failed post GROUPS for this category in [period, until).
// Groups, not rows: a multi-channel post is several rows of one publication.
// `until` is mandatory when counting a period that has ended — without it,
// today's posts would count toward yesterday's quota and hide a real miss.
//
// Counts EVERY non-failed post in the category, including ones a human made by
// hand. That is intended: the quota is "this category publishes N times a
// period", not "autopilot publishes N times a period", so a post you made
// yourself satisfies the day and autopilot stays quiet.
async function countLandedGroups(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  categoryKey: string,
  period: string,
  until?: string,
): Promise<number> {
  let query = supabase
    .from("posts")
    .select("post_group_id")
    .eq("user_id", workflow.user_id)
    .eq("category_key", categoryKey)
    .neq("status", "failed")
    .gte("created_at", periodStartUtc(period, workflow.timezone).toISOString());
  if (until) {
    query = query.lt("created_at", periodStartUtc(until, workflow.timezone).toISOString());
  }
  const { data, error } = await query;
  if (error) throw new Error(`landed-post query failed: ${error.message}`);
  return new Set((data ?? []).map((r) => (r as { post_group_id: string }).post_group_id)).size;
}

async function lastErrorForPeriod(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  period: string | null,
): Promise<string> {
  if (!period) return "";
  const { data } = await supabase
    .from("autopilot_runs")
    .select("error")
    .eq("workflow_id", workflow.id)
    .eq("user_id", workflow.user_id)
    .eq("period_start", period)
    .eq("state", "failed")
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? [])[0] as { error: string } | undefined)?.error ?? "";
}

async function advanceRun(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  run: AutopilotRun,
  now: Date,
  budget: { ideaGenerations: number },
): Promise<void> {
  // `current` tracks the freshest view of the row so the catch below appends
  // its failure to the steps a step function already persisted.
  // A run READ as `publishing` is one a previous tick left behind mid-post.
  // It is resolved from the record, never advanced: the only way to leave this
  // state is to find out what happened, because the alternative is a second,
  // un-unpostable Buffer post of the same carousel.
  //
  // Handled OUTSIDE the try below on purpose. That catch turns a throw into a
  // plain failRun — which would drop the run to `failed` still carrying its
  // idea_id, and tier 1 would then re-select exactly the carousel this
  // function exists to protect. Letting the throw reach the sweep's
  // per-workflow catch instead leaves the run in `publishing`, so the next
  // tick tries to resolve it again and nothing is ever re-posted.
  if (run.state === "publishing") {
    await resolvePublishingRun(supabase, run);
    return;
  }

  let current = run;
  try {
    if (current.state === "sourcing") {
      const next = await stepSourcing(supabase, workflow, category, current, budget);
      if (!next) return;
      current = next;
    } else if (current.state === "awaiting_images") {
      const next = await stepAwaitingImages(supabase, workflow, current, now);
      if (!next) return;
      current = next;
    } else if (current.state !== "posting") {
      return;
    }
    // The only chained transition allowed in one tick: material that is
    // already on the shelf should not wait five minutes to go out. Every
    // other step ends the tick for this workflow.
    await stepPosting(supabase, workflow, category, current);
  } catch (e) {
    // A throw here is nearly always PERMANENT for this attempt —
    // scheduleValidatedPost rejects an inactive category, a missing or
    // unsucceeded generation, an unpostable idea and a stale anchor by
    // throwing. Left uncaught, the run would stay live and be retried every
    // five minutes forever: max_attempts_per_period never bites while a live
    // run exists, and the reason would never reach the run's error column,
    // so the eventual auto-pause could not say what to fix. Recording it as
    // a failed attempt is what lets both of those mechanisms work.
    const message = e instanceof Error ? e.message : String(e);
    await failRun(supabase, current, message);
  }
}

// Settles a run that a previous tick abandoned in `publishing` — the state it
// holds across the one irreversible call in this whole system.
//
// This is deliberately FAIL-SAFE rather than retry-safe. `claimRun` cannot
// help here: re-claiming a `publishing` run means `.eq("state","publishing")`
// against a row already in `publishing`, a predicate that always matches. And
// the `hasNonFailedPost` backstop reads post_images, which createPostForUser
// writes AFTER postToBuffer returns — blind in exactly the window this
// function exists to cover.
//
// What is NOT blind is the run's own post_group_id, minted and written in the
// claim update before the Buffer call (see stepPosting). So:
//
//   posts rows this attempt wrote → the write side ran; settle from them.
//   none                          → nothing proves the post did not land.
//                                   Fail, say so plainly, and quarantine.
//
// Both settlements that mean "something reached Buffer" quarantine the idea.
// Only the every-channel-failed settlement leaves it available, because that
// is the one outcome on record as having published nothing.
async function resolvePublishingRun(
  supabase: SupabaseClient,
  run: AutopilotRun,
): Promise<void> {
  if (run.post_group_id) {
    const { data, error } = await supabase
      .from("posts")
      .select("status, error, created_at")
      .eq("post_group_id", run.post_group_id)
      .eq("user_id", run.user_id);
    // A read failure leaves the run in `publishing` for the next tick rather
    // than resolving it either way. It must not be mistaken for "no rows
    // exist" (which quarantines an idea permanently), and it must not become
    // an ordinary run failure either (which would hand the idea back to tier
    // 1). Staying live costs the workflow its attempt slot until the read
    // succeeds, and spends nothing.
    if (error) {
      console.error(
        `autopilot: abandoned-publish lookup failed for run ${run.id}: ${error.message}`,
      );
      return;
    }
    const all = (data ?? []) as { status: string; error: string; created_at: string }[];

    // Only rows THIS attempt could have written count as evidence. A tier-1
    // retry deliberately reuses the prior attempt's post group, and
    // createPostForUser's cleanup only removes prior rows that are `failed`
    // AND on the same channel — so a leftover (a category whose Buffer channel
    // changed between attempts, or a cleanup delete that errored and was only
    // logged) would otherwise read as "the write side ran" for an attempt that
    // never got that far, and tier 1 would retry a carousel that may already
    // be live. The claim update is this run's last write before the Buffer
    // call, so its updated_at is the floor; both timestamps are the database's
    // own clock, and the insert strictly follows the claim in real time.
    const claimedAt = Date.parse(run.updated_at);
    const rows = Number.isFinite(claimedAt)
      ? all.filter((r) => Date.parse(r.created_at) >= claimedAt)
      : all;

    if (rows.length) {
      const failures = rows.filter((r) => r.status === "failed");
      const detail = `recovered ${rows.length - failures.length} of ${rows.length} channels queued`;
      if (failures.length === rows.length) {
        // Every channel is on record as rejected, so tier 1 may safely reuse
        // this idea and this post group on the next attempt.
        await patchRun(supabase, run, {
          state: "failed",
          error: failures.map((f) => f.error).filter(Boolean).join("; ") || "every channel failed",
          steps: appendStep(run, "recover", detail),
        });
        return;
      }
      // Quarantined even though this settles as a SUCCESS, because the tick
      // died somewhere inside createPostForUser and the writes that normally
      // mark an idea as spent come after the one that proves it published:
      // the `posts` row lands first, then `post_images`, then
      // `ideas.status = "posted"`. Killed between the first and the second and
      // the carousel is live with post_images empty — so postedGenerationIds
      // finds nothing, hasNonFailedPost stays false, the idea is still
      // `generated`, and isPostable still says yes. Today the queued `posts`
      // row hides that through countLandedGroups, but the quota resets next
      // period and tier 2 would re-select the same idea and publish it a
      // second time. An idea that demonstrably went out must never be offered
      // to autopilot again — the same reasoning that makes the quarantine
      // unbounded on the no-rows branch.
      await patchRun(supabase, run, {
        state: "succeeded",
        idea_quarantined: true,
        error: failures.length
          ? `partial: ${failures.map((f) => f.error).filter(Boolean).join("; ")}`
          : "",
        steps: appendStep(run, "recover", `${detail} — idea retired from autopilot`),
      });
      return;
    }
  }

  // The irreducible window: killed between Buffer's response and any DB write
  // at all. Failing the run is not enough on its own — the failed attempt
  // still carries idea_id, and tier 1 would re-select the same idea through
  // the same blind hasNonFailedPost check, so the automated path has to be
  // shut off for that idea explicitly. The flag has no period bound on
  // purpose: the risk of a duplicate live post does not expire when the
  // calendar day does, and tier 2 would pick the same shelved carousel up
  // again tomorrow. A human clears it by checking Buffer and posting (or not)
  // from the composer, which this flag does not affect.
  console.error(
    `autopilot: run ${run.id} was abandoned mid-publish with no post rows — ` +
    `quarantining idea ${run.idea_id ?? "(none)"}`,
  );
  await patchRun(supabase, run, {
    state: "failed",
    idea_quarantined: true,
    error:
      "abandoned mid-publish — check Buffer before retrying; " +
      "this carousel may already be live and autopilot will not offer it again",
    steps: appendStep(run, "recover", "no post rows for this run's group — idea quarantined"),
  });
}

// Returns the run to post immediately, or null when this tick is done with it.
async function stepSourcing(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  run: AutopilotRun,
  budget: { ideaGenerations: number },
): Promise<AutopilotRun | null> {
  const candidates = await loadCandidates(supabase, workflow.user_id, category.key);
  const priorAttempt = await loadPriorAttempt(supabase, run);
  const decision = selectSource({
    candidates,
    priorAttempt,
    ideaGenerationAvailable: budget.ideaGenerations > 0,
  });

  if (decision.action === "defer") {
    // Leave the run in `sourcing`; the next tick tries again. Nothing was
    // spent, so this does not consume the attempt.
    //
    // Only the FIRST defer in a row is recorded. A run can deferring-loop for
    // as long as the idea-generation budget stays spent, and one step entry
    // per five minutes forever would grow the steps JSON without adding a
    // single fact the first entry does not already state.
    const steps = run.steps ?? [];
    if (steps[steps.length - 1]?.step !== "defer") {
      await patchRun(supabase, run, { steps: appendStep(run, "defer", decision.reason) });
    }
    return null;
  }

  if (decision.action === "post") {
    const patched = await patchRun(supabase, run, {
      state: "posting",
      source: decision.source,
      idea_id: decision.ideaId,
      post_group_id: decision.postGroupId,
      steps: appendStep(run, "source", `${decision.source} → idea ${decision.ideaId.slice(0, 8)}`),
    });
    return patched;
  }

  if (decision.action === "submit_images") {
    const submission = await submitGenerations(workflow.user_id, [decision.ideaId]);
    if (!submission.submitted) {
      await failRun(supabase, run, submissionError(submission));
      return null;
    }
    await patchRun(supabase, run, {
      state: "awaiting_images",
      source: decision.source,
      idea_id: decision.ideaId,
      awaiting_images_since: new Date().toISOString(),
      steps: appendStep(run, "submit", `approved idea ${decision.ideaId.slice(0, 8)}`),
    });
    return null;
  }

  // Tier 4 — write new material. The slot is taken before the call, so a
  // throw cannot hand it to another workflow in the same tick.
  budget.ideaGenerations--;
  const result = await generateIdeas(
    workflow.user_id, category.brand_id, category.key, IDEA_BATCH,
  );
  if (!result.inserted) {
    await failRun(
      supabase, run,
      `idea generation kept nothing (${result.filteredOut} filtered out)`,
    );
    return null;
  }

  // Approve exactly one of the new batch; the rest stay at pending_review as
  // inventory. Ordered by id for a deterministic, re-runnable choice.
  const { data: fresh, error: freshErr } = await supabase
    .from("ideas")
    .select("id")
    .eq("user_id", workflow.user_id)
    .eq("batch_id", result.batchId)
    .eq("category_key", category.key)
    .order("id", { ascending: true })
    .limit(1);
  if (freshErr) throw new Error(`new-idea query failed: ${freshErr.message}`);
  const chosen = ((fresh ?? [])[0] as { id: string } | undefined)?.id;
  if (!chosen) {
    await failRun(supabase, run, "idea generation reported inserts but none were readable");
    return null;
  }

  const { error: apprErr } = await supabase
    .from("ideas")
    .update({ approved: true, status: "approved" })
    .eq("id", chosen)
    .eq("user_id", workflow.user_id);
  if (apprErr) throw new Error(`auto-approve failed: ${apprErr.message}`);

  const submission = await submitGenerations(workflow.user_id, [chosen]);
  if (!submission.submitted) {
    // The idea id rides along because this run never got as far as recording
    // it on the row — the newly-approved idea is still on the shelf for the
    // next attempt's tier 3, and the message is the only thing that says so.
    await failRun(supabase, run, `${submissionError(submission)} (idea ${chosen.slice(0, 8)})`);
    return null;
  }
  await patchRun(supabase, run, {
    state: "awaiting_images",
    source: decision.source,
    idea_id: chosen,
    awaiting_images_since: new Date().toISOString(),
    steps: appendStep(
      run, "generate",
      `${result.inserted} ideas kept, approved ${chosen.slice(0, 8)}, submitted anchor`,
    ),
  });
  return null;
}

// Returns the run to post immediately, or null when this tick is done with it.
async function stepAwaitingImages(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  run: AutopilotRun,
  now: Date,
): Promise<AutopilotRun | null> {
  if (!run.idea_id) {
    await failRun(supabase, run, "run reached awaiting_images with no idea");
    return null;
  }
  const state = await loadIdeaState(supabase, workflow.user_id, run.idea_id);
  if (!state) {
    await failRun(supabase, run, "the run's idea no longer exists");
    return null;
  }
  const decision = decideAwaitingImages({
    slideCount: state.slideCount,
    readySlideIndexes: state.readySlideIndexes,
    hasInFlightGeneration: state.hasInFlightGeneration,
    // Falls back to created_at only for a row that somehow reached this state
    // without the stamp; the two transitions into awaiting_images both write
    // it. Never the other way round — created_at can be hours older than the
    // submission, because sourcing defers whenever the app-wide tier-4 slot is
    // already spent.
    awaitingSince: run.awaiting_images_since ?? run.created_at,
    now,
  });
  if (decision.action === "wait") return null;
  if (decision.action === "fail") {
    await failRun(supabase, run, decision.error);
    return null;
  }
  return patchRun(supabase, run, {
    state: "posting",
    steps: appendStep(run, "images", `all ${state.slideCount} slides ready`),
  });
}

async function stepPosting(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  run: AutopilotRun,
): Promise<void> {
  if (!run.idea_id) {
    await failRun(supabase, run, "run reached posting with no idea");
    return;
  }
  // Checked before anything is attempted: a category with no channel can
  // never post, and saying so plainly beats a Buffer error nobody can act on.
  if (!category.buffer_connection_id || !category.buffer_channel_id) {
    await failRun(
      supabase, run,
      `category "${category.key}" has no Buffer channel configured — set one in Config`,
    );
    return;
  }

  const state = await loadIdeaState(supabase, workflow.user_id, run.idea_id);
  if (!state) {
    await failRun(supabase, run, "the run's idea no longer exists");
    return;
  }
  // Backstop for the path the claim below cannot cover: a crash or platform
  // timeout between the Buffer call and the terminal write leaves the run
  // live with its post already out, and the next tick would advance it again
  // with no competing claim to lose. Checked against the images' own post
  // history rather than the idea's status, which stays `generated` whenever a
  // channel truncated the carousel.
  if (state.hasNonFailedPost) {
    await failRun(
      supabase, run,
      "this carousel already has a live post — not posting it a second time",
    );
    return;
  }
  const generationIds = state.orderedGenerationIds;
  if (generationIds.length !== state.slideCount) {
    await failRun(supabase, run, "carousel stopped being complete before it could post");
    return;
  }

  // Claim the run before spending anything irreversible. The update matches
  // the state this tick READ (`posting`), so of two overlapping ticks holding
  // the same row only one can win it; the loser sees no affected rows and
  // stops. Without this, both would call Buffer and the carousel would go out
  // twice — scheduleValidatedPost's own idea-status check cannot prevent that,
  // since both ticks read the pre-post status before either wrote it.
  //
  // The post group id is minted HERE and written in the same update, before
  // the Buffer call rather than after it. That is what gives a run later found
  // abandoned in `publishing` something to ask `posts` about: every row
  // createPostForUser writes carries this id, so "no rows for this group"
  // means the write side never ran. Everything else the recovery path could
  // consult (posts, post_images) is written after postToBuffer returns and is
  // therefore blind in exactly that window. Tier 1's carried group is reused
  // when there is one, so the retry replaces its failed rows rather than
  // stacking new ones beside them.
  const postGroupId = run.post_group_id ?? randomUUID();
  const claimed = await claimRun(supabase, run, "publishing", postGroupId);
  if (!claimed) return;

  const caption = state.postText || category.post_caption || "";
  // The returned group id is deliberately not destructured: scheduleValidatedPost
  // only mints one when it is given none, and it is now always given ours.
  const { results, allFailed } = await scheduleValidatedPost(workflow.user_id, {
    categoryKey: category.key,
    generationIds,
    channels: [{
      connectionId: category.buffer_connection_id,
      channelId: category.buffer_channel_id,
      service: category.buffer_channel_service,
      caption,
    }],
    caption,
    // null → Buffer's own queue decides the publish time (spec §2).
    scheduledAt: null,
    postGroupId,
  });

  const failures = results.filter((r) => r.status === "failed");
  if (allFailed) {
    // post_group_id is re-stated even on failure — the claim already wrote it,
    // and it must survive to the terminal row because the next attempt's
    // tier-1 sourcing reuses it so the retry replaces these failed rows rather
    // than stacking new ones beside them.
    await patchRun(supabase, claimed, {
      state: "failed",
      post_group_id: postGroupId,
      error: failures.map((f) => f.error).join("; ") || "every channel failed",
      steps: appendStep(claimed, "post", "every channel failed"),
    });
    return;
  }

  // Partial multi-channel success counts as landed and is NOT auto-retried:
  // per-channel retry is safe mechanically, but the cost of getting it wrong
  // is a duplicate live post, so that stays a human decision in the composer.
  await patchRun(supabase, claimed, {
    state: "succeeded",
    post_group_id: postGroupId,
    error: failures.length ? `partial: ${failures.map((f) => f.error).join("; ")}` : "",
    steps: appendStep(
      claimed, "post",
      `${results.length - failures.length} of ${results.length} channels queued`,
    ),
  });
}

interface IdeaState {
  slideCount: number;
  readySlideIndexes: number[];
  orderedGenerationIds: string[];
  hasInFlightGeneration: boolean;
  // Any prior post covering one of this idea's generations that did not fail —
  // the same signal loadCandidates computes, needed here as stepPosting's
  // double-post backstop.
  hasNonFailedPost: boolean;
  postText: string;
}

async function loadIdeaState(
  supabase: SupabaseClient,
  userId: string,
  ideaId: string,
): Promise<IdeaState | null> {
  // The error is checked, not discarded: null here means "the idea is gone",
  // and both callers turn that into a permanent run failure. Letting a
  // transient read failure produce the same null would burn an attempt and
  // write a wrong reason into the auto-pause message.
  const { data: ideaRow, error: ideaErr } = await supabase
    .from("ideas").select("id, slides, post_text")
    .eq("id", ideaId).eq("user_id", userId).maybeSingle();
  if (ideaErr) throw new Error(`idea query failed: ${ideaErr.message}`);
  if (!ideaRow) return null;
  const idea = ideaRow as Pick<Idea, "id" | "slides" | "post_text">;
  const slideCount = (idea.slides ?? []).length || 1;

  const { data: genRows, error } = await supabase
    .from("generations")
    .select("id, idea_id, slide_index, anchor_generation_id, status, created_at")
    .eq("idea_id", ideaId).eq("user_id", userId);
  if (error) throw new Error(`generation query failed: ${error.message}`);
  const siblings = (genRows ?? []) as SiblingGeneration[];
  const posted = await postedGenerationIds(supabase, userId, siblings.map((g) => g.id));

  const resolved = resolveValidSlides(slideCount, siblings);
  return {
    slideCount,
    readySlideIndexes: resolved.filter((s) => s.generationId).map((s) => s.slideIndex),
    orderedGenerationIds: resolved
      .filter((s) => s.generationId)
      .map((s) => s.generationId as string),
    hasInFlightGeneration: siblings.some(
      (g) => g.status === "submitted" || g.status === "polling",
    ),
    hasNonFailedPost: siblings.some((g) => posted.has(g.id)),
    postText: idea.post_text ?? "",
  };
}

// Which of these generations already went out in a post that did not fail.
//
// Resolved through post_images, not posts.idea_id: a freeform post spanning
// several ideas carries idea_id: null, so keying off it would forget that
// this idea's slides already went out inside someone else's post.
async function postedGenerationIds(
  supabase: SupabaseClient,
  userId: string,
  generationIds: string[],
): Promise<Set<string>> {
  const posted = new Set<string>();
  if (!generationIds.length) return posted;
  const { data, error } = await supabase
    .from("post_images")
    .select("generation_id, post:posts(status)")
    .in("generation_id", generationIds)
    .eq("user_id", userId);
  if (error) throw new Error(`posted-slide query failed: ${error.message}`);
  for (const row of (data ?? []) as unknown as {
    generation_id: string; post: { status: string } | null;
  }[]) {
    if (row.post && row.post.status !== "failed") posted.add(row.generation_id);
  }
  return posted;
}

async function loadCandidates(
  supabase: SupabaseClient,
  userId: string,
  categoryKey: string,
): Promise<IdeaCandidate[]> {
  const { data: ideaRows, error: ideaErr } = await supabase
    .from("ideas")
    .select("id, status, slides, created_at")
    .eq("user_id", userId)
    .eq("category_key", categoryKey)
    .in("status", ["approved", "generated"])
    .order("created_at", { ascending: true })
    .limit(CANDIDATE_LIMIT);
  if (ideaErr) throw new Error(`candidate query failed: ${ideaErr.message}`);
  const ideas = (ideaRows ?? []) as Pick<Idea, "id" | "status" | "slides" | "created_at">[];
  if (!ideas.length) return [];
  const ideaIds = ideas.map((i) => i.id);

  const { data: genRows, error: genErr } = await supabase
    .from("generations")
    .select("id, idea_id, slide_index, anchor_generation_id, status, created_at")
    .in("idea_id", ideaIds)
    .eq("user_id", userId);
  if (genErr) throw new Error(`candidate generation query failed: ${genErr.message}`);
  const gens = (genRows ?? []) as SiblingGeneration[];
  const postedGenIds = await postedGenerationIds(supabase, userId, gens.map((g) => g.id));

  const { data: claimRows, error: claimErr } = await supabase
    .from("autopilot_runs")
    .select("idea_id")
    .eq("user_id", userId)
    .in("state", LIVE_STATES)
    .in("idea_id", ideaIds);
  if (claimErr) throw new Error(`claim query failed: ${claimErr.message}`);
  const claimed = new Set(
    ((claimRows ?? []) as { idea_id: string | null }[]).map((r) => r.idea_id).filter(Boolean),
  );

  // Ideas belonging to a run that was abandoned mid-publish with nothing in
  // `posts` to say whether Buffer received the carousel. Dropped from the
  // candidate list entirely rather than marked on the candidate, because
  // "maybe already live" disqualifies an idea from EVERY tier, not just the
  // ones isPostable covers — and isPostable's own hasNonFailedPost signal is
  // precisely the thing that is blind in this case. Deliberately not scoped to
  // a period: the duplicate-post risk does not expire at midnight, and tier 2
  // would otherwise pick the same shelved carousel up again tomorrow.
  const { data: quarantineRows, error: quarantineErr } = await supabase
    .from("autopilot_runs")
    .select("idea_id")
    .eq("user_id", userId)
    .eq("idea_quarantined", true)
    .in("idea_id", ideaIds);
  if (quarantineErr) throw new Error(`quarantine query failed: ${quarantineErr.message}`);
  const quarantined = new Set(
    ((quarantineRows ?? []) as { idea_id: string | null }[]).map((r) => r.idea_id).filter(Boolean),
  );

  return ideas.filter((idea) => !quarantined.has(idea.id)).map((idea) => {
    const siblings = gens.filter((g) => g.idea_id === idea.id);
    const slideCount = (idea.slides ?? []).length || 1;
    const resolved = resolveValidSlides(slideCount, siblings);
    return {
      ideaId: idea.id,
      status: idea.status,
      slideCount,
      readySlideIndexes: resolved.filter((s) => s.generationId).map((s) => s.slideIndex),
      hasNonFailedPost: siblings.some((g) => postedGenIds.has(g.id)),
      hasInFlightGeneration: siblings.some(
        (g) => g.status === "submitted" || g.status === "polling",
      ),
      claimedByLiveRun: claimed.has(idea.id),
      createdAt: idea.created_at,
    };
  });
}

// The most recent earlier attempt in this run's own period — tier 1's input.
async function loadPriorAttempt(
  supabase: SupabaseClient,
  run: AutopilotRun,
): Promise<{ ideaId: string; postGroupId: string | null } | null> {
  const { data } = await supabase
    .from("autopilot_runs")
    .select("idea_id, post_group_id")
    .eq("workflow_id", run.workflow_id)
    .eq("user_id", run.user_id)
    .eq("period_start", run.period_start)
    .eq("state", "failed")
    .order("created_at", { ascending: false })
    .limit(1);
  const prior = ((data ?? [])[0] ?? null) as
    | { idea_id: string | null; post_group_id: string | null }
    | null;
  if (!prior?.idea_id) return null;
  return { ideaId: prior.idea_id, postGroupId: prior.post_group_id };
}

// submitGenerations REPORTS rather than throws: an ineligible idea is counted
// as `skipped`, and a per-idea failure is caught inside its own loop and
// pushed onto `errors`. Discarding that result would move the run to
// awaiting_images with nothing in flight, and the reason a human needs would
// be replaced 30 minutes later by "images stalled: 0 of N slides ready" — a
// symptom, not the cause. Spec §4 makes the run's `error` the thing that makes
// a 3am failure visible, and auto-pause quotes it verbatim.
function submissionError(result: { failed: number; skipped: number; errors: string[] }): string {
  const reason = result.errors.filter(Boolean).join("; ");
  if (reason) return `image submission failed: ${reason}`;
  if (result.skipped) return "image submission skipped this idea as ineligible";
  return "image submission produced nothing";
}

function appendStep(run: AutopilotRun, step: string, detail: string): AutopilotRunStep[] {
  return [...(run.steps ?? []), { at: new Date().toISOString(), step, detail }];
}

async function patchRun(
  supabase: SupabaseClient,
  run: AutopilotRun,
  values: Partial<
    Pick<
      AutopilotRun,
      "state" | "error" | "idea_id" | "post_group_id" | "steps"
      | "awaiting_images_since" | "idea_quarantined"
    >
  > & { source?: AutopilotSource },
): Promise<AutopilotRun> {
  const { error } = await supabase
    .from("autopilot_runs")
    .update(values)
    .eq("id", run.id)
    .eq("user_id", run.user_id);
  if (error) throw new Error(`run update failed: ${error.message}`);
  return { ...run, ...values } as AutopilotRun;
}

// Moves a run to `next`, and records the post group it is about to publish
// under, only if its stored state is still the one this tick read — reporting
// whether it won. The `.eq("state", …)` is the whole point: Postgres evaluates
// it against the committed row, so exactly one of two overlapping ticks can
// match, and `.select()` tells us which one we were. It is only a real
// predicate because the caller is in `posting` and asking for `publishing`;
// re-claiming a run already in `publishing` would compare a value with itself,
// which is why that path resolves instead (see resolvePublishingRun).
//
// Deliberately writes no step entry, so a caller holding the pre-claim run
// object can still append to `steps` without dropping one.
async function claimRun(
  supabase: SupabaseClient,
  run: AutopilotRun,
  next: AutopilotRunState,
  postGroupId: string,
): Promise<AutopilotRun | null> {
  // Columns enumerated, never spread — same rule as every other write here.
  const values = { state: next, post_group_id: postGroupId };
  const { data, error } = await supabase
    .from("autopilot_runs")
    .update(values)
    .eq("id", run.id)
    .eq("user_id", run.user_id)
    .eq("state", run.state)
    .select("id");
  if (error) throw new Error(`run claim failed: ${error.message}`);
  if (!(data ?? []).length) {
    console.warn(`autopilot: run ${run.id} was already claimed by another tick`);
    return null;
  }
  return { ...run, ...values };
}

async function failRun(
  supabase: SupabaseClient,
  run: AutopilotRun,
  message: string,
): Promise<void> {
  console.error(`autopilot: run ${run.id} failed: ${message}`);
  await patchRun(supabase, run, {
    state: "failed",
    error: message,
    steps: appendStep(run, "fail", message),
  });
}
