import "server-only";
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
  AutopilotRun, AutopilotRunStep, AutopilotSource, AutopilotWorkflow, Category, Idea,
} from "@/lib/types";

// How many workflows one tick looks at. At a 5-minute cadence this is far more
// than any single tenant needs, and it bounds the tick's DB work.
export const WORKFLOW_TICK_CAP = 20;
// How many ideas are considered as sourcing candidates per workflow.
const CANDIDATE_LIMIT = 50;

const LIVE_STATES = ["sourcing", "awaiting_images", "posting"];

export interface TickSummary {
  workflowsExamined: number;
  runsOpened: number;
  runsAdvanced: number;
  errors: string[];
}

type WorkflowRow = AutopilotWorkflow & { category: Category | null };

export async function runAutopilotTick(now: Date = new Date()): Promise<TickSummary> {
  const supabase = createAdminSupabase();
  const summary: TickSummary = {
    workflowsExamined: 0, runsOpened: 0, runsAdvanced: 0, errors: [],
  };

  // The one query with no tenant predicate, and deliberately so: this is the
  // app-wide sweep that finds which tenants have work. Everything below it is
  // scoped to the user_id of the row it came from.
  const { data, error } = await supabase
    .from("autopilot_workflows")
    .select("*, category:categories(*)")
    .eq("active", true)
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
    const { category, ...workflow } = row;
    if (!category?.active) continue;
    summary.workflowsExamined++;
    try {
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
  if (run.state === "sourcing") {
    const next = await stepSourcing(supabase, workflow, category, run, budget);
    // The only chained transition allowed in one tick: material that is
    // already on the shelf should not wait five minutes to go out. Every
    // other step ends the tick for this workflow.
    if (next) await stepPosting(supabase, workflow, category, next);
    return;
  }
  if (run.state === "awaiting_images") {
    await stepAwaitingImages(supabase, workflow, category, run, now);
    return;
  }
  if (run.state === "posting") {
    await stepPosting(supabase, workflow, category, run);
  }
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
    await patchRun(supabase, run, { steps: appendStep(run, "defer", decision.reason) });
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
    await submitGenerations(workflow.user_id, [decision.ideaId]);
    await patchRun(supabase, run, {
      state: "awaiting_images",
      source: decision.source,
      idea_id: decision.ideaId,
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

  await submitGenerations(workflow.user_id, [chosen]);
  await patchRun(supabase, run, {
    state: "awaiting_images",
    source: decision.source,
    idea_id: chosen,
    steps: appendStep(
      run, "generate",
      `${result.inserted} ideas kept, approved ${chosen.slice(0, 8)}, submitted anchor`,
    ),
  });
  return null;
}

async function stepAwaitingImages(
  supabase: SupabaseClient,
  workflow: AutopilotWorkflow,
  category: Category,
  run: AutopilotRun,
  now: Date,
): Promise<void> {
  if (!run.idea_id) {
    await failRun(supabase, run, "run reached awaiting_images with no idea");
    return;
  }
  const state = await loadIdeaState(supabase, workflow.user_id, run.idea_id);
  if (!state) {
    await failRun(supabase, run, "the run's idea no longer exists");
    return;
  }
  const decision = decideAwaitingImages({
    slideCount: state.slideCount,
    readySlideIndexes: state.readySlideIndexes,
    hasInFlightGeneration: state.hasInFlightGeneration,
    runCreatedAt: run.created_at,
    now,
  });
  if (decision.action === "wait") return;
  if (decision.action === "fail") {
    await failRun(supabase, run, decision.error);
    return;
  }
  const patched = await patchRun(supabase, run, {
    state: "posting",
    steps: appendStep(run, "images", `all ${state.slideCount} slides ready`),
  });
  await stepPosting(supabase, workflow, category, patched);
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
  const generationIds = state.orderedGenerationIds;
  if (generationIds.length !== state.slideCount) {
    await failRun(supabase, run, "carousel stopped being complete before it could post");
    return;
  }

  const caption = state.postText || category.post_caption || "";
  const { postGroupId, results, allFailed } = await scheduleValidatedPost(workflow.user_id, {
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
    postGroupId: run.post_group_id,
  });

  const failures = results.filter((r) => r.status === "failed");
  if (allFailed) {
    // post_group_id is recorded even on failure: the next attempt's tier-1
    // sourcing reuses it so the retry replaces these failed rows rather than
    // stacking new ones beside them.
    await patchRun(supabase, run, {
      state: "failed",
      post_group_id: postGroupId,
      error: failures.map((f) => f.error).join("; ") || "every channel failed",
      steps: appendStep(run, "post", "every channel failed"),
    });
    return;
  }

  // Partial multi-channel success counts as landed and is NOT auto-retried:
  // per-channel retry is safe mechanically, but the cost of getting it wrong
  // is a duplicate live post, so that stays a human decision in the composer.
  await patchRun(supabase, run, {
    state: "succeeded",
    post_group_id: postGroupId,
    error: failures.length ? `partial: ${failures.map((f) => f.error).join("; ")}` : "",
    steps: appendStep(
      run, "post",
      `${results.length - failures.length} of ${results.length} channels queued`,
    ),
  });
}

interface IdeaState {
  slideCount: number;
  readySlideIndexes: number[];
  orderedGenerationIds: string[];
  hasInFlightGeneration: boolean;
  postText: string;
}

async function loadIdeaState(
  supabase: SupabaseClient,
  userId: string,
  ideaId: string,
): Promise<IdeaState | null> {
  const { data: ideaRow } = await supabase
    .from("ideas").select("id, slides, post_text")
    .eq("id", ideaId).eq("user_id", userId).maybeSingle();
  if (!ideaRow) return null;
  const idea = ideaRow as Pick<Idea, "id" | "slides" | "post_text">;
  const slideCount = (idea.slides ?? []).length || 1;

  const { data: genRows, error } = await supabase
    .from("generations")
    .select("id, idea_id, slide_index, anchor_generation_id, status, created_at")
    .eq("idea_id", ideaId).eq("user_id", userId);
  if (error) throw new Error(`generation query failed: ${error.message}`);
  const siblings = (genRows ?? []) as SiblingGeneration[];

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
    postText: idea.post_text ?? "",
  };
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

  // Resolved through post_images, not posts.idea_id: a freeform post spanning
  // several ideas carries idea_id: null, so keying off it would forget that
  // this idea's slides already went out inside someone else's post.
  const postedGenIds = new Set<string>();
  if (gens.length) {
    const { data: postedRows, error: postedErr } = await supabase
      .from("post_images")
      .select("generation_id, post:posts(status)")
      .in("generation_id", gens.map((g) => g.id))
      .eq("user_id", userId);
    if (postedErr) throw new Error(`posted-slide query failed: ${postedErr.message}`);
    for (const row of (postedRows ?? []) as unknown as {
      generation_id: string; post: { status: string } | null;
    }[]) {
      if (row.post && row.post.status !== "failed") postedGenIds.add(row.generation_id);
    }
  }

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

  return ideas.map((idea) => {
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

function appendStep(run: AutopilotRun, step: string, detail: string): AutopilotRunStep[] {
  return [...(run.steps ?? []), { at: new Date().toISOString(), step, detail }];
}

async function patchRun(
  supabase: SupabaseClient,
  run: AutopilotRun,
  values: Partial<
    Pick<AutopilotRun, "state" | "error" | "idea_id" | "post_group_id" | "steps">
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
