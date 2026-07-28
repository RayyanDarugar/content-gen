"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Slide } from "@/lib/types";

interface Props {
  categoryId: string;
  postType: "independent" | "narrative";
  hasStyleRef: boolean;
  hasKieKey: boolean;
}

interface TaskState { taskId: string; url?: string; status: "pending" | "done" | "failed"; error?: string }

interface PreviewRun {
  concept: string;
  slides: Slide[];
  styleUrl: string;
  anchor: TaskState;
  fanout: TaskState[] | null;
}

// Confirmed against the state values documented on the preview route's GET
// handler (app/api/categories/draft/preview/route.ts:79-80): "success" ->
// done, "fail" -> failed, anything else -> still in flight.
const DONE_STATE = "success";
const FAILED_STATE = "fail";

// Kie polling is documented as intermittently flaky, and production tolerates
// this via cron re-polls (see repo docs). A single bad poll — a network
// blip, a malformed body, or one non-ok response — must not permanently fail
// a slide when the underlying task may still succeed seconds later. Only
// give up after this many CONSECUTIVE poll errors.
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

async function pollTask(taskId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  let consecutiveErrors = 0;
  let lastError: string | undefined;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`/api/categories/draft/preview?taskId=${encodeURIComponent(taskId)}`);
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
      // A network-level failure (fetch rejects) — treat like any other
      // transient failed poll rather than throwing out of the caller's
      // Promise.all.
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

export function PreviewPane({ categoryId, postType, hasStyleRef, hasKieKey }: Props) {
  const [run, setRun] = useState<PreviewRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function startTest() {
    setBusy(true);
    setError("");
    setRun(null);
    try {
      const res = await fetch("/api/categories/draft/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId, phase: "start" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const initial: PreviewRun = {
        concept: json.concept, slides: json.slides, styleUrl: json.styleUrl,
        anchor: { taskId: json.taskId, status: "pending" }, fanout: null,
      };
      setRun(initial);
      const done = await pollTask(json.taskId);
      setRun((p) => p && {
        ...p,
        anchor: { ...p.anchor, status: done.ok ? "done" : "failed", url: done.url, error: done.error },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function fullTest() {
    if (!run?.anchor.url) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/categories/draft/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId, phase: "fanout",
          slides: run.slides, styleUrl: run.styleUrl, anchorImageUrl: run.anchor.url,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const taskIds: string[] = json.taskIds;
      setRun((p) => p && { ...p, fanout: taskIds.map((taskId) => ({ taskId, status: "pending" as const })) });
      // Each slide polls independently; one slide's failure — including an
      // unexpected throw — must not strand its siblings in "generating…"
      // forever, so every callback catches its own errors and always
      // resolves (Promise.all never rejects here).
      await Promise.all(
        taskIds.map(async (taskId, i) => {
          let done: { ok: boolean; url?: string; error?: string };
          try {
            done = await pollTask(taskId);
          } catch (e) {
            done = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
          setRun((p) => {
            if (!p?.fanout) return p;
            const fanout = [...p.fanout];
            fanout[i] = { taskId, status: done.ok ? "done" : "failed", url: done.url, error: done.error };
            return { ...p, fanout };
          });
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Test run</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Generates one real sample post against this draft. Nothing is saved to your ideas or gallery.
        </p>
        {!hasKieKey && <p className="text-muted-foreground">Add your Kie.ai API key in Config to run tests.</p>}
        {hasKieKey && !hasStyleRef && (
          <p className="text-muted-foreground">
            This draft has no brand visual reference image — add one on the start screen or in the category editor,
            then re-open the wizard.
          </p>
        )}
        {hasKieKey && hasStyleRef && (
          <div className="flex gap-2">
            <Button size="sm" onClick={startTest} disabled={busy}>
              {busy && !run ? "Generating…" : run ? "Retry test" : "Test this draft"}
            </Button>
            {postType === "narrative" && run?.anchor.status === "done" && !run.fanout && (
              <Button size="sm" variant="outline" onClick={fullTest} disabled={busy}>
                Generate full test carousel
              </Button>
            )}
          </div>
        )}
        {run && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Sample idea: {run.concept}</p>
            <div className="flex flex-wrap gap-2">
              <PreviewImage state={run.anchor} label={run.slides[0]?.role ?? "anchor"} />
              {run.fanout?.map((t, i) => (
                <PreviewImage key={t.taskId} state={t} label={run.slides[i + 1]?.role ?? `slide ${i + 2}`} />
              ))}
            </div>
          </div>
        )}
        {error && <p className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function PreviewImage({ state, label }: { state: TaskState; label: string }) {
  return (
    <div className="w-32">
      {state.status === "pending" && (
        <div className="flex h-40 w-32 items-center justify-center rounded border text-xs text-muted-foreground">
          generating…
        </div>
      )}
      {state.status === "failed" && (
        <div className="flex h-40 w-32 items-center justify-center rounded border border-destructive p-2 text-center text-xs text-destructive">
          {state.error ?? "failed"}
        </div>
      )}
      {state.status === "done" && state.url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.url} alt={label} className="h-40 w-32 rounded border object-cover" />
      )}
      <p className="mt-1 text-center text-xs capitalize text-muted-foreground">{label}</p>
    </div>
  );
}
