"use client";

import { Briefcase, Camera, Globe, Loader2, Music2, Plus, X, type LucideIcon } from "lucide-react";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger,
} from "@/components/ui/select";
import { normalizeService } from "@/lib/platform";
import { encodeChannelChoice, decodeChannelChoice } from "@/lib/channel-choice";
import type { ChannelGroup } from "@/lib/settings/buffer";

// Adaptation/copy state for one selected channel. `dirty` is the one flag
// every adapt/re-adapt call must check at apply time (Global Constraint:
// adaptation never clobbers a hand edit). `warning` is distinct from
// `error`/`status: "failed"` — it means the channel DID post but some
// bookkeeping after the fact failed (posts/create's `results[].warning`),
// so it renders as a caution, not a failure.
export interface SelectedChannel {
  connectionId: string;
  channelId: string;
  service: string;
  label: string; // display name
  caption: string;
  dirty: boolean; // hand-edited: never auto-re-adapt
  adapting: boolean;
  status?: "queued" | "failed";
  error?: string;
  warning?: string;
}

const SERVICE_ICON: Record<string, LucideIcon> = {
  tiktok: Music2,
  instagram: Camera,
  linkedin: Briefcase,
  x: X,
  generic: Globe,
};

function ServiceIcon({ service, className }: { service: string; className?: string }) {
  const Icon = SERVICE_ICON[normalizeService(service)];
  return <Icon className={className} />;
}

function statusDotClass(ch: SelectedChannel): string {
  if (ch.status === "failed") return "bg-destructive";
  if (ch.warning) return "bg-status-pending";
  if (ch.status === "queued") return "bg-status-success";
  return "bg-transparent";
}

export function ChannelChips({
  groups,
  selected,
  onAdd,
  onRemove,
  focusedChannelId,
  onFocus,
}: {
  groups: ChannelGroup[];
  selected: SelectedChannel[];
  onAdd(ch: { connectionId: string; channelId: string; service: string; label: string }): void;
  onRemove(channelId: string): void;
  focusedChannelId: string | null;
  onFocus(channelId: string | null): void;
}) {
  const selectedIds = new Set(selected.map((s) => s.channelId));

  function requestRemove(ch: SelectedChannel) {
    if (ch.dirty && !confirm("This channel's copy was edited — remove it?")) return;
    onRemove(ch.channelId);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {selected.map((ch) => {
        const focused = focusedChannelId === ch.channelId;
        return (
          <div
            key={ch.channelId}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors ${
              focused ? "border-foreground/40 bg-muted" : "border-border hover:border-foreground/25"
            }`}
          >
            <button
              type="button"
              onClick={() => onFocus(ch.channelId)}
              className="flex items-center gap-1.5"
              title={ch.error || ch.warning || undefined}
            >
              <ServiceIcon service={ch.service} className="size-3.5 text-muted-foreground" />
              <span>{ch.label}</span>
              {ch.adapting && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
              {ch.status && <span className={`size-1.5 rounded-full ${statusDotClass(ch)}`} />}
            </button>
            <button
              type="button"
              aria-label={`Remove ${ch.label}`}
              onClick={() => requestRemove(ch)}
              className="text-muted-foreground hover:text-destructive"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}

      <Select
        value=""
        onValueChange={(value) => {
          const choice = typeof value === "string" ? decodeChannelChoice(value) : null;
          if (!choice) return;
          const group = groups.find((g) => g.connectionId === choice.connectionId);
          const channel = group?.channels.find((c) => c.id === choice.channelId);
          onAdd({
            connectionId: choice.connectionId,
            channelId: choice.channelId,
            service: choice.service,
            label: channel?.displayName || channel?.name || choice.service,
          });
        }}
      >
        <SelectTrigger size="sm">
          <Plus className="size-3.5" /> Add channel
        </SelectTrigger>
        <SelectContent>
          {groups.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No Buffer connections yet — add one in Config.
            </p>
          )}
          {groups.map((g) => (
            <SelectGroup key={g.connectionId}>
              <SelectLabel>{g.error ? `${g.label} (unavailable)` : g.label}</SelectLabel>
              {g.channels.map((c) => (
                <SelectItem
                  key={c.id}
                  value={encodeChannelChoice(g.connectionId, c.id, c.service)}
                  disabled={selectedIds.has(c.id)}
                >
                  <ServiceIcon service={c.service} className="size-3.5" />
                  {c.displayName || c.name} ({c.service})
                  {selectedIds.has(c.id) ? " · added" : ""}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
