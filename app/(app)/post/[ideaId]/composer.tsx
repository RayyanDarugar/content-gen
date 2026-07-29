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
import { mediaForPlatform, normalizeService } from "@/lib/platform";
import { summarizeFanOut, type ChannelResult } from "@/lib/athena/fan-out";
import type { ChannelGroup } from "@/lib/settings/buffer";
import { ChannelChips, type SelectedChannel } from "./channel-chips";
import { CopyTabs } from "./copy-tabs";
import type { BufferChannel, Category, Generation, Idea } from "@/lib/types";

type IdeaWithGenerations = Idea & { generations: Generation[] };

interface Slot {
  key: string;
  slideIndex: number | null; // null for freeform pool additions
  generationId: string | null;
  publicUrl: string;
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
  postedByChannel,
  groups,
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
  postedByChannel: Record<string, number[]>;
  groups: ChannelGroup[];
  brandName: string;
  schedulingEnabled: boolean;
}) {
  const router = useRouter();

  const [slots, setSlots] = useState<Slot[]>(() =>
    resolved.map((r) => ({
      key: newSlotKey(),
      slideIndex: r.slideIndex,
      generationId: r.generationId,
      publicUrl: r.publicUrl,
    })),
  );
  const [baseCaption, setBaseCaption] = useState(
    () => idea.post_text.trim() || pickCaption(category.post_caption),
  );
  const [selected, setSelected] = useState<SelectedChannel[]>(() =>
    !channelMissing && category.buffer_channel_id
      ? [
          {
            connectionId: category.buffer_connection_id ?? "",
            channelId: category.buffer_channel_id,
            service: category.buffer_channel_service,
            label: channel?.displayName || channel?.name || category.buffer_channel_service,
            // Reuse the already-resolved baseCaption rather than re-picking —
            // category.post_caption can hold several "||"-separated variants,
            // and a second independent pickCaption() call could randomly land
            // on a different one, seeding this channel's tab out of sync
            // with Base from the very first render.
            caption: baseCaption,
            dirty: false,
            adapting: false,
          },
        ]
      : [],
  );
  const [focusedChannelId, setFocusedChannelId] = useState<string | null>(null);
  const [postGroupId, setPostGroupId] = useState<string | null>(null);

  const [swapKey, setSwapKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const [scheduleMode, setScheduleMode] = useState<"next" | "pick">("next");
  const [scheduledAt, setScheduledAt] = useState("");

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [rewriteNote, setRewriteNote] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const [rewriteError, setRewriteError] = useState("");

  // Every Buffer channel across every connection, so the preview can look up
  // a focused channel's own avatar/display name even when it isn't this
  // category's own connection.
  const allChannelsById = useMemo(() => {
    const m = new Map<string, BufferChannel>();
    for (const g of groups) for (const c of g.channels) m.set(c.id, c);
    return m;
  }, [groups]);

  // Which slide indexes render as "already posted" in the media strip.
  // Per-channel when a channel tab is focused; the union of every channel
  // this idea has ever gone out to when the Base tab is focused (Global
  // Constraint: "Posted-slot marking is per-channel... Base tab shows the
  // union across channels").
  const focusedPostedIndexSet = useMemo(() => {
    if (focusedChannelId === null) {
      const set = new Set<number>();
      for (const idxs of Object.values(postedByChannel)) for (const i of idxs) set.add(i);
      return set;
    }
    return new Set(postedByChannel[focusedChannelId] ?? []);
  }, [focusedChannelId, postedByChannel]);

  // What actually gets EXCLUDED from the outgoing submission. One request
  // sends the same media list to every currently selected channel (spec
  // §6/§11: one strip, no per-channel media selection) — so unlike the
  // display set above (which follows whichever tab you're looking at), this
  // must stay independent of focus: a slide already posted to ANY currently
  // selected channel must be dropped from the shared list, or that channel
  // would be posted to twice. This is deliberately a superset of "posted
  // under the focused tab only" — see composer's design note in the task
  // report for the tradeoff this implies.
  const submissionExcludedIndexSet = useMemo(() => {
    const set = new Set<number>();
    for (const s of selected) for (const i of postedByChannel[s.channelId] ?? []) set.add(i);
    return set;
  }, [selected, postedByChannel]);

  // "filled" is what this submission would actually post: slides already
  // posted to a currently-selected channel are excluded so reopening the
  // composer (or leaving another channel selected) never re-submits a slide
  // that channel already received. usedIds still covers every occupied slot
  // so an already-posted image can't also be offered as a swap/add candidate
  // elsewhere in the strip.
  const filled = slots.filter(
    (s): s is Slot & { generationId: string } =>
      !!s.generationId && !(s.slideIndex != null && submissionExcludedIndexSet.has(s.slideIndex)),
  );
  const usedIds = new Set(slots.filter((s) => s.generationId).map((s) => s.generationId));
  const previewUrls = filled.map((s) => s.publicUrl);

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
      { key: newSlotKey(), slideIndex: null, generationId: candidate.id, publicUrl: candidate.url },
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

  // Auto-adapt: fires on add and on an explicit re-adapt click, both funneled
  // through here. The caller resets dirty:false/adapting:true on the target
  // channel BEFORE calling this, so the only thing this function must get
  // right is checking dirtiness again once the response lands — the user may
  // have started typing while the request was in flight, and that hand edit
  // must win (Global Constraint).
  async function runAdapt(channelId: string, service: string) {
    try {
      const res = await fetch("/api/posts/adapt-caption", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categoryKey: category.key, ideaId: idea.id, baseText: baseCaption, service }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSelected((prev) => prev.map((s) => {
        if (s.channelId !== channelId) return s;
        // Checked NOW, at apply time, not when the request was sent — a
        // dirty flip in between (the user typed while this was in flight)
        // must not be clobbered.
        if (s.dirty) return { ...s, adapting: false };
        return { ...s, caption: json.text, adapting: false, error: undefined };
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSelected((prev) => prev.map((s) => (s.channelId === channelId ? { ...s, adapting: false, error: msg } : s)));
    }
  }

  function onAdd(ch: { connectionId: string; channelId: string; service: string; label: string }) {
    setSelected((prev) => [...prev, { ...ch, caption: baseCaption, dirty: false, adapting: true }]);
    void runAdapt(ch.channelId, ch.service);
  }

  function onRemoveChannel(channelId: string) {
    setSelected((prev) => prev.filter((s) => s.channelId !== channelId));
    setFocusedChannelId((prev) => (prev === channelId ? null : prev));
  }

  function onReadapt(channelId: string) {
    const target = selected.find((s) => s.channelId === channelId);
    if (!target) return;
    setSelected((prev) => prev.map((s) => (s.channelId === channelId ? { ...s, dirty: false, adapting: true, error: undefined } : s)));
    void runAdapt(channelId, target.service);
  }

  function onChannelCaptionChange(channelId: string, text: string) {
    setSelected((prev) => prev.map((s) => (s.channelId === channelId ? { ...s, caption: text, dirty: true } : s)));
  }

  function truncatedNoteFor(channelId: string): string {
    const ch = selected.find((s) => s.channelId === channelId);
    if (!ch) return "";
    const full = previewUrls;
    const trimmed = mediaForPlatform(full, normalizeService(ch.service));
    if (trimmed.length === full.length) return "";
    const dropped = full.length - trimmed.length;
    return `${ch.label} carries ${trimmed.length} image${trimmed.length === 1 ? "" : "s"} — the last ${dropped} won't be sent.`;
  }

  function applyResults(results: ChannelResult[]) {
    setSelected((prev) => prev.map((s) => {
      const r = results.find((x) => x.channelId === s.channelId);
      if (!r) return s;
      return { ...s, status: r.status, error: r.error, warning: r.warning };
    }));
  }

  async function post() {
    setBusy(true);
    setMessage(null);
    try {
      const scheduling = schedulingEnabled && scheduleMode === "pick" && scheduledAt.trim() !== "";
      const body: Record<string, unknown> = {
        category_key: category.key,
        generation_ids: filled.map((s) => s.generationId),
        caption: baseCaption,
        channels: selected.map((s) => ({
          connectionId: s.connectionId, channelId: s.channelId, service: s.service, caption: s.caption,
        })),
      };
      if (scheduling) body.scheduled_at = new Date(scheduledAt).toISOString();
      const res = await fetch("/api/posts/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      const results: ChannelResult[] = Array.isArray(json.results) ? json.results : [];
      if (!res.ok && results.length === 0) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPostGroupId(typeof json.postGroupId === "string" ? json.postGroupId : null);
      applyResults(results);
      const summary = summarizeFanOut(results);
      // Finding 6: "Queued in Buffer" is only true for the addToQueue path —
      // a custom-time post never touches Buffer's queue, so say what
      // actually happened instead.
      setMessage({
        ok: !summary.allFailed,
        text: scheduling && summary.queued > 0
          ? `Scheduled for ${new Date(scheduledAt).toLocaleString()} — ${summary.label}`
          : summary.label || "Nothing was queued",
      });
      if (summary.failed === 0) {
        setTimeout(() => router.push("/post"), 800);
      }
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    const failedChannels = selected.filter((s) => s.status === "failed");
    if (failedChannels.length === 0 || !postGroupId) return;
    setBusy(true);
    setMessage(null);
    try {
      const scheduling = schedulingEnabled && scheduleMode === "pick" && scheduledAt.trim() !== "";
      const body: Record<string, unknown> = {
        category_key: category.key,
        generation_ids: filled.map((s) => s.generationId),
        caption: baseCaption,
        channels: failedChannels.map((s) => ({
          connectionId: s.connectionId, channelId: s.channelId, service: s.service, caption: s.caption,
        })),
        post_group_id: postGroupId,
      };
      if (scheduling) body.scheduled_at = new Date(scheduledAt).toISOString();
      const res = await fetch("/api/posts/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      const results: ChannelResult[] = Array.isArray(json.results) ? json.results : [];
      if (!res.ok && results.length === 0) throw new Error(json.error ?? `HTTP ${res.status}`);
      applyResults(results);
      const summary = summarizeFanOut(results);
      setMessage({ ok: !summary.allFailed, text: summary.label || "Nothing was queued" });
      if (summary.failed === 0) {
        setTimeout(() => router.push("/post"), 800);
      }
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
      const currentText = focusedChannelId === null
        ? baseCaption
        : selected.find((s) => s.channelId === focusedChannelId)?.caption ?? baseCaption;
      const res = await fetch("/api/posts/rewrite-caption", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          categoryKey: category.key,
          ideaId: idea.id,
          note: rewriteNote,
          imageUrls: previewUrls,
          currentText,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (focusedChannelId === null) {
        setBaseCaption(json.text);
      } else {
        const channelId = focusedChannelId;
        setSelected((prev) => prev.map((s) => (s.channelId === channelId ? { ...s, caption: json.text, dirty: true } : s)));
      }
      setRewriteNote("");
    } catch (e) {
      setRewriteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRewriting(false);
    }
  }

  const focusedChannel = focusedChannelId != null ? selected.find((s) => s.channelId === focusedChannelId) ?? null : null;
  const focusedBufferChannel = focusedChannel ? allChannelsById.get(focusedChannel.channelId) ?? null : null;
  const previewService = focusedChannel ? focusedChannel.service : category.buffer_channel_service;
  const previewCaption = focusedChannel ? focusedChannel.caption : baseCaption;
  const previewImageUrls = mediaForPlatform(previewUrls, normalizeService(previewService));

  const hasFailed = selected.some((s) => s.status === "failed");

  // Finding 4: a "pick a time" post with no time chosen must not be
  // postable — the button used to say "Schedule" while silently falling
  // back to add-to-queue behavior.
  const canPost =
    selected.length > 0 &&
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
          <p className="text-sm font-medium">Channels</p>
          <ChannelChips
            groups={groups}
            selected={selected}
            onAdd={onAdd}
            onRemove={onRemoveChannel}
            focusedChannelId={focusedChannelId}
            onFocus={setFocusedChannelId}
          />
        </section>

        <section className="space-y-2">
          <CopyTabs
            baseCaption={baseCaption}
            onBaseChange={setBaseCaption}
            selected={selected}
            focusedChannelId={focusedChannelId}
            onFocus={setFocusedChannelId}
            onChannelCaptionChange={onChannelCaptionChange}
            onReadapt={onReadapt}
            truncatedNoteFor={truncatedNoteFor}
          />
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
            {slots.map((slot, idx) => {
              const alreadyPosted = slot.slideIndex != null && focusedPostedIndexSet.has(slot.slideIndex);
              return (
                <div key={slot.key} className="relative w-28 space-y-1">
                  {slot.generationId ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={slot.publicUrl}
                        alt={`Slide ${idx + 1}`}
                        className={`h-28 w-28 rounded-xl border object-cover ${alreadyPosted ? "opacity-50" : ""}`}
                      />
                      {alreadyPosted ? (
                        // Finding 3: already went out (to this view's channel(s))
                        // — visually distinct and not selectable.
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
                  {!alreadyPosted && (
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
              );
            })}
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
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button onClick={post} disabled={!canPost} className="rounded-full">
              {busy ? "Posting…" : scheduleMode === "pick" && schedulingEnabled ? "Schedule" : "Add to queue"}
            </Button>
            {selected.length === 0 && (
              <span className="text-sm text-muted-foreground">Add at least one channel to post.</span>
            )}
            {hasFailed && (
              <Button variant="outline" size="sm" disabled={busy} onClick={retryFailed}>
                Retry failed channels
              </Button>
            )}
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
          service={previewService}
          imageUrls={previewImageUrls}
          caption={previewCaption}
          accountName={focusedBufferChannel?.displayName || focusedChannel?.label || channel?.displayName || brandName}
          avatarUrl={focusedChannel ? (focusedBufferChannel?.avatar ?? "") : (channel?.avatar ?? "")}
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
