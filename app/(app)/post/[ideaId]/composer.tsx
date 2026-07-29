"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { PlatformPreview } from "@/components/preview/platform-preview";
import { pickCaption, type Postable, type SlideResolution } from "@/lib/athena/carousel";
import { normalizeService, platformCharLimit } from "@/lib/platform";
import type { BufferChannel, Category, Generation, Idea } from "@/lib/types";

type IdeaWithGenerations = Idea & { generations: Generation[] };

interface Slot {
  key: string;
  slideIndex: number | null; // null for freeform pool additions
  generationId: string | null;
  publicUrl: string;
  // Finding 3: already went out in a prior (non-failed) post for this idea.
  // Rendered visually distinct, not swappable/removable, and excluded from
  // the submit payload — re-submitting it would double-publish.
  alreadyPosted: boolean;
}

let slotSeq = 0;
function newSlotKey() {
  slotSeq += 1;
  return `slot-${slotSeq}`;
}

// Local-time value in the shape <input type="datetime-local"> expects
// (YYYY-MM-DDTHH:mm), used as the `min` bound so the picker can't be set to
// a moment already in the past (Finding 5).
function nowLocalInputValue(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function Composer({
  idea,
  category,
  channel,
  channelMissing,
  channelsError,
  resolved,
  pool,
  postedSlideIndexes,
  brandName,
  schedulingEnabled,
}: {
  idea: IdeaWithGenerations;
  category: Category;
  channel: BufferChannel | null;
  channelMissing: boolean;
  channelsError: string;
  resolved: SlideResolution[];
  pool: Postable[];
  postedSlideIndexes: number[];
  brandName: string;
  schedulingEnabled: boolean;
}) {
  const router = useRouter();
  const postedSlideIndexSet = useMemo(() => new Set(postedSlideIndexes), [postedSlideIndexes]);

  const [slots, setSlots] = useState<Slot[]>(() =>
    resolved.map((r) => ({
      key: newSlotKey(),
      slideIndex: r.slideIndex,
      generationId: r.generationId,
      publicUrl: r.publicUrl,
      alreadyPosted: postedSlideIndexSet.has(r.slideIndex),
    })),
  );
  const [caption, setCaption] = useState(
    () => idea.post_text.trim() || pickCaption(category.post_caption),
  );
  const [swapKey, setSwapKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const [scheduleMode, setScheduleMode] = useState<"next" | "pick">("next");
  const [scheduledAt, setScheduledAt] = useState("");

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [rewriteNote, setRewriteNote] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const [rewriteError, setRewriteError] = useState("");

  const platformKey = normalizeService(category.buffer_channel_service);
  const charLimit = platformCharLimit(platformKey);

  // "filled" is what this submission would actually post: alreadyPosted
  // slots are excluded so reopening the composer never re-submits a slide
  // that already went out in an earlier post (Finding 3). usedIds still
  // covers every occupied slot (posted or not) so an already-posted image
  // can't also be offered as a swap/add candidate elsewhere in the strip.
  const filled = slots.filter((s): s is Slot & { generationId: string } => !!s.generationId && !s.alreadyPosted);
  const usedIds = new Set(slots.filter((s) => s.generationId).map((s) => s.generationId));
  const previewUrls = slots.filter((s) => !s.alreadyPosted).map((s) => s.publicUrl);

  // Every succeeded generation for the idea, grouped by slide, so "Swap"
  // can offer that slide's other attempts (a retried anchor, a manual
  // regenerate) before falling back to the wider category pool.
  const siblingsBySlide = useMemo(() => {
    const map = new Map<number, { id: string; url: string; created_at: string }[]>();
    for (const g of idea.generations) {
      if (g.status !== "succeeded" || !g.public_url) continue;
      const list = map.get(g.slide_index) ?? [];
      list.push({ id: g.id, url: g.public_url, created_at: g.created_at });
      map.set(g.slide_index, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return map;
  }, [idea.generations]);

  function candidatesFor(slot: Slot | null): { id: string; url: string; label: string }[] {
    const siblings = slot?.slideIndex != null
      ? (siblingsBySlide.get(slot.slideIndex) ?? [])
          .filter((g) => g.id !== slot.generationId)
          .map((g) => ({ id: g.id, url: g.url, label: `Slide ${slot.slideIndex! + 1} · other attempt` }))
      : [];
    const siblingIds = new Set(siblings.map((s) => s.id));
    const poolCandidates = pool
      .filter((p) => !usedIds.has(p.generation_id) && !siblingIds.has(p.generation_id) && p.generation_id !== slot?.generationId)
      .map((p) => ({ id: p.generation_id, url: p.public_url, label: p.concept.slice(0, 60) }));
    return [...siblings, ...poolCandidates];
  }

  function swapSlot(key: string, candidate: { id: string; url: string }) {
    setSlots((prev) => prev.map((s) => (s.key === key ? { ...s, generationId: candidate.id, publicUrl: candidate.url } : s)));
    setSwapKey(null);
  }

  function addSlot(candidate: { id: string; url: string }) {
    setSlots((prev) => [
      ...prev,
      { key: newSlotKey(), slideIndex: null, generationId: candidate.id, publicUrl: candidate.url, alreadyPosted: false },
    ]);
    setAddOpen(false);
  }

  function removeSlot(key: string) {
    setSlots((prev) => prev.filter((s) => s.key !== key));
    if (swapKey === key) setSwapKey(null);
  }

  function moveSlot(idx: number, dir: -1 | 1) {
    setSlots((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  async function post() {
    setBusy(true);
    setMessage(null);
    try {
      const scheduling = schedulingEnabled && scheduleMode === "pick" && scheduledAt.trim() !== "";
      const body: Record<string, unknown> = {
        category_key: category.key,
        generation_ids: filled.map((s) => s.generationId),
        caption,
      };
      if (scheduling) {
        body.scheduled_at = new Date(scheduledAt).toISOString();
      }
      const res = await fetch("/api/posts/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      // Finding 6: "Queued in Buffer" is only true for the addToQueue path —
      // a custom-time post never touches Buffer's queue, so say what
      // actually happened instead.
      setMessage({
        ok: true,
        text: scheduling
          ? `Scheduled for ${new Date(scheduledAt).toLocaleString()}`
          : `Queued in Buffer (${json.buffer_update_id})`,
      });
      setTimeout(() => router.push("/post"), 800);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function rewrite() {
    setRewriting(true);
    setRewriteError("");
    try {
      const res = await fetch("/api/posts/rewrite-caption", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          categoryKey: category.key,
          ideaId: idea.id,
          note: rewriteNote,
          imageUrls: filled.map((s) => s.publicUrl),
          currentText: caption,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCaption(json.text);
      setRewriteNote("");
    } catch (e) {
      setRewriteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRewriting(false);
    }
  }

  // Finding 4: a "pick a time" post with no time chosen must not be
  // postable — the button used to say "Schedule" while silently falling
  // back to add-to-queue behavior.
  const canPost =
    !channelMissing &&
    filled.length > 0 &&
    !busy &&
    (scheduleMode !== "pick" || !schedulingEnabled || scheduledAt.trim() !== "");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <header className="space-y-2">
          <Link href="/post" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Back to queue
          </Link>
          {channelMissing ? (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              This category&apos;s Buffer channel isn&apos;t available on its connection.{" "}
              <Link href="/config" className="underline">Pick it again in Config.</Link>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {channel?.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={channel.avatar} alt="" className="size-8 rounded-full object-cover" />
              ) : (
                <div className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                  {(channel?.displayName || brandName).trim().charAt(0).toUpperCase() || "?"}
                </div>
              )}
              <div className="text-sm">
                <p className="font-medium">{channel?.displayName || brandName}</p>
                <p className="text-xs text-muted-foreground">{category.buffer_channel_service}</p>
              </div>
              {channelsError && (
                <span className="ml-2 text-xs text-status-pending">
                  Could not verify this channel with Buffer: {channelsError}
                </span>
              )}
            </div>
          )}
        </header>

        <section className="space-y-2">
          <Textarea
            rows={5}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Caption"
            className="text-base"
          />
          {charLimit != null && (
            <p className={caption.length > charLimit ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {caption.length}/{charLimit}
            </p>
          )}
          <div className="flex gap-2">
            <Textarea
              rows={1}
              placeholder="Rewrite the copy… (e.g. shorter, punchier hook)"
              value={rewriteNote}
              onChange={(e) => setRewriteNote(e.target.value)}
            />
            <Button variant="outline" size="sm" disabled={rewriting || !rewriteNote.trim()} onClick={rewrite}>
              {rewriting ? "Rewriting…" : "Rewrite with notes"}
            </Button>
          </div>
          {rewriteError && <p className="text-sm text-destructive">{rewriteError}</p>}
        </section>

        <section className="space-y-2">
          <p className="text-sm font-medium">Media</p>
          <div className="flex flex-wrap gap-3">
            {slots.map((slot, idx) => (
              <div key={slot.key} className="relative w-28 space-y-1">
                {slot.generationId ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={slot.publicUrl}
                      alt={`Slide ${idx + 1}`}
                      className={`h-28 w-28 rounded-xl border object-cover ${slot.alreadyPosted ? "opacity-50" : ""}`}
                    />
                    {slot.alreadyPosted ? (
                      // Finding 3: already went out — visually distinct,
                      // not selectable (no swap/move/remove), and left out
                      // of the submit payload above.
                      <span className="block rounded-full bg-muted px-1.5 py-0.5 text-center text-[10px] font-medium text-muted-foreground">
                        Posted
                      </span>
                    ) : (
                      <>
                        <div className="flex items-center justify-between text-xs">
                          <button type="button" onClick={() => moveSlot(idx, -1)} disabled={idx === 0} aria-label="Move left">
                            <ChevronLeft className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            className="underline"
                            onClick={() => setSwapKey(swapKey === slot.key ? null : slot.key)}
                          >
                            Swap
                          </button>
                          <button type="button" onClick={() => moveSlot(idx, 1)} disabled={idx === slots.length - 1} aria-label="Move right">
                            <ChevronRight className="size-3.5" />
                          </button>
                        </div>
                        {swapKey === slot.key && (
                          <SwapPanel candidates={candidatesFor(slot)} onPick={(c) => swapSlot(slot.key, c)} />
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <div className="flex h-28 w-28 flex-col items-center justify-center rounded-xl border border-dashed text-center text-[11px] text-muted-foreground">
                    waiting on generation
                  </div>
                )}
                {!slot.alreadyPosted && (
                  <button
                    type="button"
                    onClick={() => removeSlot(slot.key)}
                    aria-label="Remove slide"
                    className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-foreground/15 hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            ))}
            <div className="relative w-28">
              <button
                type="button"
                onClick={() => setAddOpen((v) => !v)}
                className="flex h-28 w-28 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              >
                + add
              </button>
              {addOpen && <SwapPanel candidates={candidatesFor(null)} onPick={addSlot} />}
            </div>
          </div>
        </section>

        <section className="space-y-2 rounded-xl border p-3">
          <div className="flex items-center gap-2 text-sm">
            <Button
              type="button"
              variant={scheduleMode === "next" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setScheduleMode("next")}
            >
              Next available
            </Button>
            <Button
              type="button"
              variant={scheduleMode === "pick" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setScheduleMode("pick")}
            >
              Pick a time
            </Button>
          </div>
          {scheduleMode === "pick" && (
            <div className="space-y-1">
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                disabled={!schedulingEnabled}
                min={nowLocalInputValue()}
                className="w-56"
              />
              {!schedulingEnabled && (
                <p className="text-xs text-muted-foreground">
                  Scheduling isn&apos;t wired up yet — this post will join Buffer&apos;s next available slot instead.
                </p>
              )}
            </div>
          )}
          <div className="flex items-center gap-3 pt-1">
            <Button onClick={post} disabled={!canPost} className="rounded-full">
              {busy ? "Posting…" : scheduleMode === "pick" && schedulingEnabled ? "Schedule" : "Add to queue"}
            </Button>
            {message && (
              <span className={`text-sm ${message.ok ? "text-status-success" : "text-destructive"}`}>
                {message.text}
              </span>
            )}
          </div>
        </section>
      </div>

      <div className="lg:sticky lg:top-6 lg:self-start">
        <PlatformPreview
          service={category.buffer_channel_service}
          imageUrls={previewUrls}
          caption={caption}
          accountName={channel?.displayName || brandName}
          avatarUrl={channel?.avatar ?? ""}
          aspectRatio={category.aspect_ratio}
        />
      </div>
    </div>
  );
}

function SwapPanel({
  candidates,
  onPick,
}: {
  candidates: { id: string; url: string; label: string }[];
  onPick: (c: { id: string; url: string }) => void;
}) {
  if (candidates.length === 0) {
    return <p className="text-[11px] text-muted-foreground">Nothing else available yet.</p>;
  }
  return (
    <div className="absolute left-0 top-full z-10 mt-1 flex w-56 flex-wrap gap-1.5 rounded-lg border bg-popover p-2 shadow-lg">
      {candidates.map((c) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={c.id}
          src={c.url}
          alt={c.label}
          title={c.label}
          onClick={() => onPick(c)}
          className="h-12 w-12 cursor-pointer rounded-lg border object-cover opacity-80 transition-opacity hover:opacity-100"
        />
      ))}
    </div>
  );
}
