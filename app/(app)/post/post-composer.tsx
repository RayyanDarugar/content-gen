"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { pickCaption, selectAutoFill, type Postable } from "@/lib/athena/carousel";
import { categoryColor } from "@/lib/category-colors";
import type { Category } from "@/lib/types";

export function PostComposer({
  category,
  postables,
}: {
  category: Category;
  postables: Postable[];
}) {
  const router = useRouter();
  const n = category.images_per_carousel;
  const initial = useMemo(() => selectAutoFill(postables, n), [postables, n]);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    initial.map((p) => p.generation_id),
  );
  const [caption, setCaption] = useState(() => pickCaption(category.post_caption));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const byId = useMemo(
    () => new Map(postables.map((p) => [p.generation_id, p])),
    [postables],
  );

  useEffect(() => {
    setSelectedIds((ids) => {
      const stillValid = ids.filter((id) => byId.has(id));
      if (stillValid.length === ids.length) return ids;
      const need = n - stillValid.length;
      if (need <= 0) return stillValid;
      const usedIds = new Set(stillValid);
      const fillIns = selectAutoFill(
        postables.filter((p) => !usedIds.has(p.generation_id)),
        need,
      ).map((p) => p.generation_id);
      return [...stillValid, ...fillIns];
    });
  }, [byId, postables, n]);

  const selected = selectedIds.map((id) => byId.get(id)!).filter(Boolean);
  const pool = postables.filter((p) => !selectedIds.includes(p.generation_id));
  const ready = postables.length >= n;

  function remove(id: string) {
    setSelectedIds((ids) => ids.filter((x) => x !== id));
  }
  function add(id: string) {
    setSelectedIds((ids) => (ids.length < n ? [...ids, id] : ids));
  }
  function move(idx: number, dir: -1 | 1) {
    setSelectedIds((ids) => {
      const j = idx + dir;
      if (j < 0 || j >= ids.length) return ids;
      const next = [...ids];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  async function post() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/posts/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category_key: category.key,
          generation_ids: selectedIds,
          caption,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMessage({ ok: true, text: `Queued in Buffer (${json.buffer_update_id})` });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="rounded-2xl bg-card ring-1 ring-foreground/10 border-l-4 p-4 space-y-3 transition-all hover:-translate-y-0.5 hover:shadow-lg hover:ring-primary/30"
      style={{ borderLeftColor: categoryColor(category.key) }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg">{category.name}</h2>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, (postables.length / n) * 100)}%` }}
            />
          </span>
          {Math.min(postables.length, n)} of {n} ready
        </span>
      </div>

      {!ready ? (
        <p className="text-sm text-muted-foreground">
          Not enough postable images yet ({postables.length} of {n}).
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            {selected.map((p, idx) => (
              <div key={p.generation_id} className="relative w-28 space-y-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.public_url}
                  alt={p.concept.slice(0, 60)}
                  className="h-28 w-28 cursor-pointer rounded-xl border object-cover transition-transform hover:scale-95"
                  onClick={() => remove(p.generation_id)}
                  title="Click to remove"
                />
                <div className="flex items-center justify-between text-xs">
                  <button onClick={() => move(idx, -1)} disabled={idx === 0}>◀</button>
                  <span>{idx + 1}</span>
                  <button onClick={() => move(idx, 1)} disabled={idx === selected.length - 1}>▶</button>
                </div>
              </div>
            ))}
          </div>

          {pool.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Swap in (click to add{selectedIds.length >= n ? " — remove one first" : ""}):
              </p>
              <div className="flex flex-wrap gap-2">
                {pool.map((p) => (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={p.generation_id}
                    src={p.public_url}
                    alt={p.concept.slice(0, 60)}
                    className="h-16 w-16 cursor-pointer rounded-xl border object-cover opacity-70 transition-all hover:scale-105 hover:opacity-100"
                    onClick={() => add(p.generation_id)}
                  />
                ))}
              </div>
            </div>
          )}

          <Textarea
            rows={2}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Caption"
          />
          <div className="flex items-center gap-3">
            <Button onClick={post} disabled={busy || selectedIds.length !== n} className="rounded-full">
              {busy ? "Posting…" : `Post ${n === 1 ? "image" : "carousel"} to Buffer`}
            </Button>
            {message && (
              <span className={`text-sm ${message.ok ? "text-status-success" : "text-destructive"}`}>
                {message.text}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
