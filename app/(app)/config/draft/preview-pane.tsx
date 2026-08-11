"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { pollTask, generateStyleRef, persistStyleRef } from "@/lib/style-ref-client";
import type { Slide } from "@/lib/types";

interface Props {
  categoryId: string;
  postType: "independent" | "narrative";
  styleRefUrl: string; // "" means no reference at all right now
  isPersisted: boolean; // false means styleRefUrl exists but isn't in the DB yet
  hasKieKey: boolean;
  onStyleRefGenerated: (url: string) => void;
}

interface TaskState {
  taskId: string;
  url?: string; // clean image — the only value ever sent onward to Kie (anchorImageUrl, cementing)
  displayUrl?: string; // composited (if any) or same as url — render-only
  status: "pending" | "done" | "failed";
  error?: string;
}

interface PreviewRun {
  concept: string;
  slides: Slide[];
  styleUrl: string;
  anchor: TaskState;
  fanout: TaskState[] | null;
}

type Role = Slide["role"];
const ALL_ROLES: readonly Role[] = ["hook", "beat", "payoff", "single"];

// One entry per DONE image in the run, tagged with the role its slide plays.
// "anchor" is always slides[0]; fanout[i] is always slides[i + 1] (§10).
// `url` (clean) is what cementRefs sends to promote-refs; `displayUrl`
// (composited, when present) is only ever for the thumbnail below.
interface RefCandidate { key: string; url: string; displayUrl: string; role: Role }

function buildCandidates(run: PreviewRun): RefCandidate[] {
  const list: RefCandidate[] = [];
  if (run.anchor.status === "done" && run.anchor.url && run.slides[0]) {
    list.push({
      key: "anchor", url: run.anchor.url,
      displayUrl: run.anchor.displayUrl ?? run.anchor.url, role: run.slides[0].role,
    });
  }
  run.fanout?.forEach((t, i) => {
    if (t.status === "done" && t.url && run.slides[i + 1]) {
      list.push({
        key: t.taskId, url: t.url,
        displayUrl: t.displayUrl ?? t.url, role: run.slides[i + 1].role,
      });
    }
  });
  return list;
}

function groupByRole(candidates: RefCandidate[]): Map<Role, RefCandidate[]> {
  const byRole = new Map<Role, RefCandidate[]>();
  for (const c of candidates) {
    const arr = byRole.get(c.role) ?? [];
    arr.push(c);
    byRole.set(c.role, arr);
  }
  return byRole;
}

export function PreviewPane({ categoryId, postType, styleRefUrl, isPersisted, hasKieKey, onStyleRefGenerated }: Props) {
  const [run, setRun] = useState<PreviewRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stageMessage, setStageMessage] = useState("");
  const [notes, setNotes] = useState("");
  const [regenerating, setRegenerating] = useState(false);

  // Promotion state — local to the pane (§10). Keyed by role, not by
  // candidate identity, so it survives re-renders across polling updates.
  const [selection, setSelection] = useState<Partial<Record<Role, string>>>({});
  const [excludedRoles, setExcludedRoles] = useState<Set<Role>>(new Set());
  const [promoteState, setPromoteState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [promoteError, setPromoteError] = useState("");

  async function startTest() {
    setBusy(true);
    setError("");
    setRun(null);
    // A fresh test run invalidates any prior candidate keys/selections.
    setSelection({});
    setExcludedRoles(new Set());
    setPromoteState("idle");
    setPromoteError("");
    try {
      let refUrl = styleRefUrl;
      if (refUrl && !isPersisted) {
        setStageMessage("Saving your uploaded reference image…");
        refUrl = await persistStyleRef(categoryId, refUrl);
        onStyleRefGenerated(refUrl);
      } else if (!refUrl) {
        setStageMessage("Generating a starter reference image for your brand…");
        refUrl = await generateStyleRef(categoryId);
        onStyleRefGenerated(refUrl);
      }
      setStageMessage("Generating your sample post…");
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
      const done = await pollTask(json.taskId, { categoryId, role: json.slides[0].role });
      setRun((p) => p && {
        ...p,
        anchor: {
          ...p.anchor, status: done.ok ? "done" : "failed",
          url: done.url, displayUrl: done.displayUrl, error: done.error,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStageMessage("");
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
          slides: run.slides, styleUrl: run.styleUrl,
          // Must be the clean url, never displayUrl: this becomes Kie's
          // carousel anchor, and a composited (e.g. QR-stamped) image here
          // would have every later slide generated against a smeared code.
          // Do not "simplify" run.anchor back to a single url field.
          anchorImageUrl: run.anchor.url,
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
          let done: { ok: boolean; url?: string; displayUrl?: string; error?: string };
          try {
            const role = run.slides[i + 1]?.role;
            done = role
              ? await pollTask(taskId, { categoryId, role })
              : { ok: false, error: "no slide role for this task" };
          } catch (e) {
            done = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
          setRun((p) => {
            if (!p?.fanout) return p;
            const fanout = [...p.fanout];
            fanout[i] = {
              taskId, status: done.ok ? "done" : "failed",
              url: done.url, displayUrl: done.displayUrl, error: done.error,
            };
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

  const candidates = run ? buildCandidates(run) : [];
  const byRole = groupByRole(candidates);

  async function cementRefs() {
    const refs: Partial<Record<Role, string>> = {};
    for (const [role, list] of byRole.entries()) {
      if (excludedRoles.has(role)) continue;
      const selectedKey = selection[role] ?? list[0].key;
      const candidate = list.find((c) => c.key === selectedKey) ?? list[0];
      refs[role] = candidate.url;
    }
    if (!Object.keys(refs).length) return;
    setPromoteState("pending");
    setPromoteError("");
    try {
      const res = await fetch("/api/categories/draft/promote-refs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId, refs }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPromoteState("success");
    } catch (e) {
      setPromoteError(e instanceof Error ? e.message : String(e));
      setPromoteState("error");
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
        {hasKieKey && (
          <div className="space-y-2 border-b pb-3">
            <p className="text-xs font-medium text-muted-foreground">Brand reference image</p>
            {styleRefUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={styleRefUrl} alt="brand style reference" className="h-24 w-24 rounded border object-cover" />
            ) : (
              <p className="text-xs text-muted-foreground">
                None yet — one is generated automatically from your brand the first time you test this draft.
              </p>
            )}
            <div className="flex gap-2">
              <Textarea rows={1} placeholder="Optional notes for regenerating (e.g. more muted colors)"
                value={notes} onChange={(e) => setNotes(e.target.value)} className="text-xs" />
              <Button size="sm" variant="outline" disabled={regenerating || busy}
                onClick={async () => {
                  setRegenerating(true);
                  setError("");
                  try {
                    const url = await generateStyleRef(categoryId, notes.trim() || undefined);
                    onStyleRefGenerated(url);
                    setNotes("");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setRegenerating(false);
                  }
                }}>
                {regenerating ? "Regenerating…" : "Regenerate"}
              </Button>
            </div>
          </div>
        )}
        {hasKieKey && (
          <div className="flex gap-2">
            <Button size="sm" onClick={startTest} disabled={busy || regenerating}>
              {busy && !run ? (stageMessage || "Generating…") : run ? "Retry test" : "Test this draft"}
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
        {candidates.length > 0 && (
          <div className="space-y-3 border-t pt-3">
            <p className="text-sm font-medium">Cement as reference images</p>
            <p className="text-xs text-muted-foreground">
              Pick one image per role below. Future posts in this category will generate against these
              images instead of the brand style reference.
            </p>
            <div className="space-y-3">
              {ALL_ROLES.filter((role) => byRole.has(role)).map((role) => {
                const list = byRole.get(role)!;
                const selectedKey = selection[role] ?? list[0].key;
                const isExcluded = excludedRoles.has(role);
                return (
                  <div key={role} className="space-y-1">
                    <label className="flex items-center gap-2 text-xs font-medium capitalize">
                      <input
                        type="checkbox"
                        checked={!isExcluded}
                        onChange={(e) => {
                          setExcludedRoles((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(role);
                            else next.add(role);
                            return next;
                          });
                        }}
                      />
                      {role}
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {list.map((c) => (
                        <button
                          key={c.key}
                          type="button"
                          onClick={() => setSelection((prev) => ({ ...prev, [role]: c.key }))}
                          className={`overflow-hidden rounded border-2 ${
                            selectedKey === c.key ? "border-primary ring-2 ring-primary" : "border-transparent"
                          } ${isExcluded ? "opacity-50" : ""}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={c.displayUrl} alt={`${role} candidate`} className="h-20 w-16 object-cover" />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={cementRefs} disabled={promoteState === "pending"}>
                {promoteState === "pending"
                  ? "Cementing…"
                  : promoteState === "error"
                    ? "Retry"
                    : "Cement selected as references"}
              </Button>
              {promoteState === "success" && (
                <span className="text-xs text-muted-foreground">
                  References updated — future posts in this category will generate against these images.
                </span>
              )}
            </div>
            {promoteState === "error" && <p className="text-xs text-destructive">{promoteError}</p>}
          </div>
        )}
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
      {state.status === "done" && (state.displayUrl ?? state.url) && (
        // Render displayUrl (composited, when present) — humans see the
        // overlay; only the clean `url` is ever sent onward to Kie.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.displayUrl ?? state.url} alt={label} className="h-40 w-32 rounded border object-cover" />
      )}
      <p className="mt-1 text-center text-xs capitalize text-muted-foreground">{label}</p>
    </div>
  );
}
