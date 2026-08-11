"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { PlatformPreview } from "@/components/preview/platform-preview";
import { pickCaption, type Postable, type SlideResolution } from "@/lib/athena/carousel";
import { publishedImageUrl } from "@/lib/athena/published-image";
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
  unfilledSlots = 0,
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
  unfilledSlots?: number;
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
            // Never adapted — this default chip follows Base verbatim
            // (Critical, review) until/unless the user re-adapts it
            // explicitly.
            adapted: false,
            adapting: false,
          },
        ]
      : [],
  );
  const [focusedChannelId, setFocusedChannelId] = useState<string | null>(null);
  const [postGroupId, setPostGroupId] = useState<string | null>(null);
  // Fix (review, Critical): `postedByChannel` is a server snapshot taken at
  // page render and never refreshed. Without this, a channel that just
  // queued in THIS session still reads as fresh from that stale prop, so
  // re-clicking the primary button would re-submit it and double-post to a
  // live channel. This records, client-side, exactly which slide indexes
  // were actually sent to which channel this session, merged with the
  // server snapshot below (`effectivePostedByChannel`) so every downstream
  // consumer — the media strip, the exclusion set, the channel filter —
  // sees a channel's own success without needing a page reload.
  const [sessionPostedByChannel, setSessionPostedByChannel] = useState<Record<string, number[]>>({});
  // MUST-FIX (review, triage): slide-indexed media stays protected by
  // `sessionPostedByChannel` above, but a freeform "+ add" pool slot carries
  // `slideIndex: null` and is covered by NO memory there. Without a separate
  // record, removing an already-queued chip and re-adding it produces a
  // fresh `SelectedChannel` with no `status`, so those freeform images could
  // be re-sent to a channel that already has them live. Tracked structurally
  // — every channel id that has ever queued this session — so re-adding one
  // restores `status: "queued"` instead of coming back submittable.
  const [everQueuedChannelIds, setEverQueuedChannelIds] = useState<Set<string>>(new Set());
  // Per-channel adapt/re-adapt request tokens (review, Minor): removing a
  // channel and re-adding it reuses the same channelId, so a stale
  // in-flight request from the ORIGINAL add could otherwise land after the
  // re-add and clobber the new instance's state. Each call to `beginAdapt`
  // mints a fresh token for that channelId; `runAdapt` only applies its
  // result if it's still the newest token on file for that channelId.
  const adaptTokensRef = useRef<Map<string, number>>(new Map());
  const tokenSeqRef = useRef(0);
  function beginAdapt(channelId: string): number {
    const token = tokenSeqRef.current + 1;
    tokenSeqRef.current = token;
    adaptTokensRef.current.set(channelId, token);
    return token;
  }

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

  // The server snapshot merged with this session's own successes (see the
  // `sessionPostedByChannel` note above) — the single source of truth every
  // posted-slide computation below reads from.
  const effectivePostedByChannel = useMemo(() => {
    const merged: Record<string, number[]> = {};
    const keys = new Set([...Object.keys(postedByChannel), ...Object.keys(sessionPostedByChannel)]);
    for (const key of keys) {
      const set = new Set<number>([...(postedByChannel[key] ?? []), ...(sessionPostedByChannel[key] ?? [])]);
      merged[key] = Array.from(set);
    }
    return merged;
  }, [postedByChannel, sessionPostedByChannel]);

  // A selected channel that already queued — this session or in a prior
  // session — must never appear in a subsequent submission's `channels[]`
  // (review, Critical) until the user explicitly removes and re-adds it.
  const pendingChannels = useMemo(() => selected.filter((s) => s.status !== "queued"), [selected]);

  // Which slide indexes render as "already posted" in the media strip.
  // Per-channel when a channel tab is focused; the union of every channel
  // this idea has ever gone out to when the Base tab is focused (Global
  // Constraint: "Posted-slot marking is per-channel... Base tab shows the
  // union across channels").
  const focusedPostedIndexSet = useMemo(() => {
    if (focusedChannelId === null) {
      const set = new Set<number>();
      for (const idxs of Object.values(effectivePostedByChannel)) for (const i of idxs) set.add(i);
      return set;
    }
    return new Set(effectivePostedByChannel[focusedChannelId] ?? []);
  }, [focusedChannelId, effectivePostedByChannel]);

  // What actually gets EXCLUDED from the outgoing submission. One request
  // sends the same media list to every channel it targets (spec §6/§11: one
  // strip, no per-channel media selection) — so unlike the display set
  // above (which follows whichever tab you're looking at), this must stay
  // independent of focus: a slide already posted to any channel this
  // submission WOULD target must be dropped from the shared list, or that
  // channel would be posted to twice. Scoped to `pendingChannels` rather
  // than every selected channel: a channel that already queued is never
  // part of `channels[]` again (see `pendingChannels`), so its posted
  // history no longer needs to hold back slides that a still-pending
  // channel legitimately hasn't received yet.
  const submissionExcludedIndexSet = useMemo(() => {
    const set = new Set<number>();
    for (const s of pendingChannels) for (const i of effectivePostedByChannel[s.channelId] ?? []) set.add(i);
    return set;
  }, [pendingChannels, effectivePostedByChannel]);

  // "filled" is what this submission would actually post: slides already
  // posted to a channel this submission would target are excluded so
  // reopening the composer (or leaving another channel selected) never
  // re-submits a slide that channel already received. usedIds still covers
  // every occupied slot so an already-posted image can't also be offered as
  // a swap/add candidate elsewhere in the strip.
  const filled = slots.filter(
    (s): s is Slot & { generationId: string } =>
      !!s.generationId && !(s.slideIndex != null && submissionExcludedIndexSet.has(s.slideIndex)),
  );
  const usedIds = new Set(slots.filter((s) => s.generationId).map((s) => s.generationId));
  const previewUrls = filled.map((s) => s.publicUrl);

  // Review, Important: `submissionExcludedIndexSet` silently drops slides
  // from the payload/preview even when the focused tab's own posted view
  // doesn't show them as posted (they were posted to a DIFFERENT selected
  // channel). Surfaced in the media strip as a distinct "already sent to…"
  // label so that exclusion isn't invisible — see render below.
  function channelsAlreadyHolding(slideIndex: number): string[] {
    return selected
      .filter((s) => (effectivePostedByChannel[s.channelId] ?? []).includes(slideIndex))
      .map((s) => s.label);
  }

  // Every succeeded generation for the idea, grouped by slide, so "Swap"
  // can offer that slide's other attempts (a retried anchor, a manual
  // regenerate) before falling back to the wider category pool.
  const siblingsBySlide = useMemo(() => {
    const map = new Map<number, { id: string; url: string; created_at: string }[]>();
    for (const g of idea.generations) {
      const url = publishedImageUrl(g);
      if (g.status !== "succeeded" || !url) continue;
      const list = map.get(g.slide_index) ?? [];
      list.push({ id: g.id, url, created_at: g.created_at });
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
  // must win (Global Constraint). `token` guards a second, subtler race
  // (review, Minor): if the channel is removed and re-added while this
  // request is in flight, the re-add reuses the same channelId, and a stale
  // response landing after that must not touch the NEW instance — checked
  // against `adaptTokensRef`, which `beginAdapt` bumps on every add/re-adapt.
  async function runAdapt(channelId: string, service: string, token: number) {
    try {
      const res = await fetch("/api/posts/adapt-caption", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categoryKey: category.key, ideaId: idea.id, baseText: baseCaption, service }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (adaptTokensRef.current.get(channelId) !== token) return; // superseded — stale response, ignore
      setSelected((prev) => prev.map((s) => {
        if (s.channelId !== channelId) return s;
        // Checked NOW, at apply time, not when the request was sent — a
        // dirty flip in between (the user typed while this was in flight)
        // must not be clobbered.
        if (s.dirty) return { ...s, adapting: false };
        // `adapted: true` (Critical, review) — this channel now has its own
        // applied adaptation, so it must stop following Base if the user
        // edits that tab afterward.
        return { ...s, caption: json.text, adapting: false, adapted: true, error: undefined };
      }));
    } catch (e) {
      if (adaptTokensRef.current.get(channelId) !== token) return; // superseded — stale response, ignore
      const msg = e instanceof Error ? e.message : String(e);
      setSelected((prev) => prev.map((s) => (s.channelId === channelId ? { ...s, adapting: false, error: msg } : s)));
    }
  }

  function onAdd(ch: { connectionId: string; channelId: string; service: string; label: string }) {
    // MUST-FIX (review, triage): re-adding a channel that already queued
    // this session must come back inert, not submittable — restore
    // `status: "queued"` instead of adapting from scratch.
    const alreadyQueued = everQueuedChannelIds.has(ch.channelId);
    setSelected((prev) => [
      ...prev,
      {
        ...ch,
        caption: baseCaption,
        dirty: false,
        adapted: false,
        adapting: !alreadyQueued,
        ...(alreadyQueued ? { status: "queued" as const } : {}),
      },
    ]);
    if (!alreadyQueued) {
      const token = beginAdapt(ch.channelId);
      void runAdapt(ch.channelId, ch.service, token);
    }
  }

  function onRemoveChannel(channelId: string) {
    setSelected((prev) => prev.filter((s) => s.channelId !== channelId));
    setFocusedChannelId((prev) => (prev === channelId ? null : prev));
  }

  function onReadapt(channelId: string) {
    const target = selected.find((s) => s.channelId === channelId);
    if (!target) return;
    setSelected((prev) => prev.map((s) => (s.channelId === channelId ? { ...s, dirty: false, adapting: true, error: undefined } : s)));
    const token = beginAdapt(channelId);
    void runAdapt(channelId, target.service, token);
  }

  function onChannelCaptionChange(channelId: string, text: string) {
    setSelected((prev) => prev.map((s) => (s.channelId === channelId ? { ...s, caption: text, dirty: true } : s)));
  }

  // Critical (review): editing the Base tab used to update only
  // `baseCaption` — the mount-time snapshot copied into the default
  // preselected chip's `caption` never followed it, so "open composer, edit
  // Base, click Add to queue" sent the MOUNT-TIME text to Buffer while the
  // Base preview showed the edit. A channel that is clean (`!dirty`) AND
  // never adapted (`!adapted`) must track Base exactly — that's what makes
  // it "the base copy unchanged" for `adapted_from_caption` purposes too.
  function onBaseCaptionChange(text: string) {
    setBaseCaption(text);
    setSelected((prev) => prev.map((s) => (!s.dirty && !s.adapted ? { ...s, caption: text } : s)));
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

  // `submittedSlots` is exactly `filled` at request time, in the same order
  // the server received as `generation_ids` — so slicing it the same way
  // the server slices `ordered` (by each channel's own `mediaForPlatform`
  // truncation) reproduces exactly what that channel actually received.
  //
  // Critical (review): folding the FULL, untruncated slide-index list into
  // every queued channel's session memory — as this used to do — would mark
  // a slide X's mosaic cap dropped from the payload as "already sent to X"
  // anyway, permanently blocking it there even though X never got it. Each
  // queued channel now only folds its own truncated prefix.
  function applyResults(results: ChannelResult[], submittedSlots: Slot[], submittedChannels: SelectedChannel[]) {
    setSelected((prev) => prev.map((s) => {
      const r = results.find((x) => x.channelId === s.channelId);
      if (!r) return s;
      return { ...s, status: r.status, error: r.error, warning: r.warning };
    }));
    const queuedResults = results.filter((r) => r.status === "queued");
    if (queuedResults.length > 0) {
      const submittedUrls = submittedSlots.map((s) => s.publicUrl);
      setSessionPostedByChannel((prev) => {
        const next = { ...prev };
        for (const r of queuedResults) {
          const service = submittedChannels.find((c) => c.channelId === r.channelId)?.service;
          if (!service) continue;
          const sentCount = mediaForPlatform(submittedUrls, normalizeService(service)).length;
          const sentSlideIndexes = submittedSlots
            .slice(0, sentCount)
            .map((s) => s.slideIndex)
            .filter((i): i is number => i != null);
          if (sentSlideIndexes.length === 0) continue;
          const set = new Set(next[r.channelId] ?? []);
          for (const i of sentSlideIndexes) set.add(i);
          next[r.channelId] = Array.from(set);
        }
        return next;
      });
      // MUST-FIX (review, triage): remembered independently of slide-index
      // memory above, since a freeform-only submission (all slideIndex:
      // null) would otherwise leave a queued channel with no session record
      // at all.
      setEverQueuedChannelIds((prev) => {
        const next = new Set(prev);
        for (const r of queuedResults) next.add(r.channelId);
        return next;
      });
    }
  }

  // Shared by the primary button and "Retry failed channels" — the only
  // difference between them is which channels they pass in. Both funnel
  // through here so the "never resubmit a channel that already queued"
  // invariant and the navigate-away decision live in exactly one place.
  async function submitChannels(channelsToSubmit: SelectedChannel[]) {
    if (channelsToSubmit.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const scheduling = schedulingEnabled && scheduleMode === "pick" && scheduledAt.trim() !== "";
      const submittedSlots = filled;
      const body: Record<string, unknown> = {
        category_key: category.key,
        generation_ids: filled.map((s) => s.generationId),
        caption: baseCaption,
        channels: channelsToSubmit.map((s) => ({
          connectionId: s.connectionId, channelId: s.channelId, service: s.service, caption: s.caption,
        })),
      };
      if (postGroupId) body.post_group_id = postGroupId;
      if (scheduling) body.scheduled_at = new Date(scheduledAt).toISOString();
      const res = await fetch("/api/posts/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      const results: ChannelResult[] = Array.isArray(json.results) ? json.results : [];
      if (!res.ok && results.length === 0) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (typeof json.postGroupId === "string") setPostGroupId(json.postGroupId);
      applyResults(results, submittedSlots, channelsToSubmit);
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
      // Navigate away only once every currently selected channel — not just
      // the ones in THIS request — is queued: a channel left untouched
      // (never submitted, or submitted in an earlier round and still
      // failed) means the post isn't fully done yet.
      const stillOutstanding = selected.some((s) => {
        const r = results.find((x) => x.channelId === s.channelId);
        const status = r ? r.status : s.status;
        return status !== "queued";
      });
      if (!stillOutstanding) {
        setTimeout(() => router.push("/post"), 800);
      }
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  // The primary button only ever submits channels that haven't already
  // queued (review, Critical) — `pendingChannels` naturally includes both
  // previously-failed channels and ones added after an earlier partial
  // submission, so re-clicking it is always safe.
  async function post() {
    await submitChannels(pendingChannels);
  }

  async function retryFailed() {
    await submitChannels(selected.filter((s) => s.status === "failed"));
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
        onBaseCaptionChange(json.text);
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
  // Whether there's anything left for the primary button to do — once every
  // selected channel has queued, it has nothing left to submit (review,
  // Critical: clicking it again must never resubmit an already-queued
  // channel, so once none are left, the button goes inert rather than
  // silently no-op-ing or re-sending).
  const allQueuedAlready = selected.length > 0 && pendingChannels.length === 0;
  const partialProgress = postGroupId != null && pendingChannels.length > 0 && pendingChannels.length < selected.length;

  // Important (review): a channel still `adapting` hasn't received its
  // platform-specific copy yet — its `caption` is still whatever it was
  // seeded with (the base copy). Posting before that call lands would send
  // e.g. LinkedIn long-form verbatim to X, the exact thing adaptation
  // exists to prevent.
  const anyPendingAdapting = pendingChannels.some((s) => s.adapting);

  // Finding 4: a "pick a time" post with no time chosen must not be
  // postable — the button used to say "Schedule" while silently falling
  // back to add-to-queue behavior.
  const canPost =
    pendingChannels.length > 0 &&
    filled.length > 0 &&
    !busy &&
    !anyPendingAdapting &&
    (scheduleMode !== "pick" || !schedulingEnabled || scheduledAt.trim() !== "");

  const primaryLabel = busy
    ? "Posting…"
    : allQueuedAlready
    ? "All channels queued"
    : partialProgress
    ? (scheduleMode === "pick" && schedulingEnabled ? "Schedule remaining" : "Add remaining to queue")
    : (scheduleMode === "pick" && schedulingEnabled ? "Schedule" : "Add to queue");

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
            onBaseChange={onBaseCaptionChange}
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
              const posted = slot.slideIndex != null && focusedPostedIndexSet.has(slot.slideIndex);
              // Review, Important: a slot can be silently dropped from the
              // outgoing payload (submissionExcludedIndexSet, scoped to
              // every channel this submission would target) without the
              // focused tab's OWN posted history showing it as posted — e.g.
              // it already went to a different selected channel. Marked
              // distinctly so that exclusion is visible where the user is
              // looking, not just invisible in the request body.
              const crossExcluded = !posted && slot.slideIndex != null && submissionExcludedIndexSet.has(slot.slideIndex);
              const locked = posted || crossExcluded;
              const holders = crossExcluded ? channelsAlreadyHolding(slot.slideIndex!) : [];
              return (
                <div key={slot.key} className="relative w-28 space-y-1">
                  {slot.generationId ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={slot.publicUrl}
                        alt={`Slide ${idx + 1}`}
                        className={`h-28 w-28 rounded-xl border object-cover ${locked ? "opacity-50" : ""}`}
                      />
                      {locked ? (
                        // Finding 3: already went out (to this view's
                        // channel(s), or to another selected channel) —
                        // visually distinct and not selectable either way.
                        <span className="block rounded-full bg-muted px-1.5 py-0.5 text-center text-[10px] font-medium text-muted-foreground">
                          {posted
                            ? "Posted"
                            : holders.length === 1
                            ? `Sent to ${holders[0]}`
                            : "Excluded — sent elsewhere"}
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
                  {!locked && (
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

        {unfilledSlots > 0 && (
          <p className="text-xs text-amber-700">
            {unfilledSlots === 1 ? "1 slot on this post has no image" : `${unfilledSlots} slots on this post have no image`}
            {" — it will publish without it. Add one on the Ideas board."}
          </p>
        )}

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
              {primaryLabel}
            </Button>
            {selected.length === 0 && (
              <span className="text-sm text-muted-foreground">Add at least one channel to post.</span>
            )}
            {allQueuedAlready && (
              <span className="text-sm text-muted-foreground">All selected channels are already queued.</span>
            )}
            {!allQueuedAlready && anyPendingAdapting && (
              <span className="text-sm text-muted-foreground">
                Waiting on platform-adapted copy before this can post…
              </span>
            )}
            {hasFailed && (
              // Important (review): same adapting gate as the primary
              // button — "Retry failed channels" is a second path into
              // `submitChannels` and must not resubmit a failed channel
              // while its copy is still mid-adaptation either.
              <Button variant="outline" size="sm" disabled={busy || anyPendingAdapting} onClick={retryFailed}>
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
