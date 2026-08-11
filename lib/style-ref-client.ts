// Confirmed against the state values documented on the preview route's GET
// handler (app/api/categories/draft/preview/route.ts): "success" -> done,
// "fail" -> failed, anything else -> still in flight.
const DONE_STATE = "success";
const FAILED_STATE = "fail";

// Kie polling is documented as intermittently flaky, and production
// tolerates this via cron re-polls. A single bad poll (network blip,
// malformed body, one non-ok response) must not permanently fail a task
// when the underlying job may still succeed seconds later. Only give up
// after this many CONSECUTIVE poll errors.
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

export interface PollResult {
  ok: boolean;
  url?: string;
  error?: string;
}

// Polls a Kie task via the existing (task-agnostic) preview GET endpoint
// until it succeeds, fails, or times out. Shared by the test-run flow and
// by style-ref generation — both are "create a Kie task, wait for it"
// operations against the exact same polling contract.
export async function pollTask(
  taskId: string,
  composite?: { categoryId: string; role: string },
): Promise<PollResult> {
  let consecutiveErrors = 0;
  let lastError: string | undefined;
  for (let i = 0; i < 60; i++) {
    try {
      const params = new URLSearchParams({ taskId });
      if (composite) {
        params.set("categoryId", composite.categoryId);
        params.set("role", composite.role);
      }
      const res = await fetch(`/api/categories/draft/preview?${params}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || json == null) {
        lastError = json?.error ?? `HTTP ${res.status}`;
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) return { ok: false, error: lastError };
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      consecutiveErrors = 0;
      if (json.state === DONE_STATE) {
        if (json.resultUrl) return { ok: true, url: json.resultUrl };
        return { ok: false, error: "generation reported success but returned no image" };
      }
      if (json.state === FAILED_STATE) return { ok: false, error: "image generation failed" };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) return { ok: false, error: lastError };
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, error: "timed out after 5 minutes" };
}

// Runs the full generate -> poll -> finalize sequence for a brand-grounded
// placeholder style reference image. Always persists the result as the
// category's real style_ref_url (see the plan's Global Constraints) — every
// caller of this function gets an immediately-persisted write, so Test Run's
// automatic first-time generation and an explicit "Regenerate" share one
// path rather than diverging on when the write happens.
export async function generateStyleRef(categoryId: string, notes?: string): Promise<string> {
  const genRes = await fetch("/api/categories/draft/style-ref", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categoryId, phase: "generate", notes }),
  });
  const genJson = await genRes.json().catch(() => null);
  if (!genRes.ok || !genJson) throw new Error(genJson?.error ?? `HTTP ${genRes.status}`);

  const done = await pollTask(genJson.taskId);
  if (!done.ok || !done.url) throw new Error(done.error ?? "style reference generation failed");

  const finalRes = await fetch("/api/categories/draft/style-ref", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categoryId, phase: "finalize", imageUrl: done.url }),
  });
  const finalJson = await finalRes.json().catch(() => null);
  if (!finalRes.ok || !finalJson) throw new Error(finalJson?.error ?? `HTTP ${finalRes.status}`);
  return finalJson.styleRefUrl as string;
}

// Persists an already-hosted image URL (e.g. one just uploaded via a manual
// file upload, not yet sent through a chat turn) as the category's real
// style_ref_url. Reuses the finalize phase's re-host+validate+persist logic
// rather than duplicating it — a fresh upload deserves the same validation
// as a freshly generated image before becoming canonical, and this is the
// ONLY path that may overwrite an existing persisted reference with
// something the user did not just explicitly regenerate.
export async function persistStyleRef(categoryId: string, imageUrl: string): Promise<string> {
  const res = await fetch("/api/categories/draft/style-ref", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categoryId, phase: "finalize", imageUrl }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.styleRefUrl as string;
}
