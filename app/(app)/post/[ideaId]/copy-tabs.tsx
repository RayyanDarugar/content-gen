"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { normalizeService, platformCharLimit } from "@/lib/platform";
import type { SelectedChannel } from "./channel-chips";

function TabButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors ${
        active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function CopyTabs({
  baseCaption,
  onBaseChange,
  selected,
  focusedChannelId,
  onFocus,
  onChannelCaptionChange,
  onReadapt,
  truncatedNoteFor,
}: {
  baseCaption: string;
  onBaseChange(text: string): void;
  selected: SelectedChannel[];
  focusedChannelId: string | null;
  onFocus(channelId: string | null): void;
  onChannelCaptionChange(channelId: string, text: string): void;
  onReadapt(channelId: string): void;
  truncatedNoteFor(channelId: string): string;
}) {
  const focused = focusedChannelId != null ? selected.find((s) => s.channelId === focusedChannelId) : null;

  function requestReadapt(ch: SelectedChannel) {
    if (ch.dirty && !confirm("This tab's copy was hand-edited — re-adapt from the base caption and overwrite it?")) {
      return;
    }
    onReadapt(ch.channelId);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1 border-b pb-2">
        <TabButton active={focusedChannelId === null} onClick={() => onFocus(null)}>
          Base
        </TabButton>
        {selected.map((ch) => (
          <TabButton key={ch.channelId} active={focusedChannelId === ch.channelId} onClick={() => onFocus(ch.channelId)}>
            {ch.label}
            {ch.dirty && <span className="size-1.5 rounded-full bg-status-pending" />}
            {ch.adapting && <Loader2 className="size-3 animate-spin" />}
          </TabButton>
        ))}
      </div>

      {focused ? (
        <ChannelTabBody
          channel={focused}
          onChange={(text) => onChannelCaptionChange(focused.channelId, text)}
          onReadapt={() => requestReadapt(focused)}
          truncatedNote={truncatedNoteFor(focused.channelId)}
        />
      ) : (
        <Textarea
          rows={5}
          value={baseCaption}
          onChange={(e) => onBaseChange(e.target.value)}
          placeholder="Caption"
          className="text-base"
        />
      )}
    </div>
  );
}

function ChannelTabBody({
  channel, onChange, onReadapt, truncatedNote,
}: {
  channel: SelectedChannel;
  onChange(text: string): void;
  onReadapt(): void;
  truncatedNote: string;
}) {
  const charLimit = platformCharLimit(normalizeService(channel.service));
  return (
    <div className="space-y-1.5">
      <Textarea
        rows={5}
        value={channel.caption}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Caption"
        className="text-base"
        disabled={channel.adapting}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {charLimit != null ? (
          <p className={channel.caption.length > charLimit ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {channel.caption.length}/{charLimit}
          </p>
        ) : <span />}
        <Button variant="outline" size="sm" disabled={channel.adapting} onClick={onReadapt}>
          {channel.adapting ? "Adapting…" : "Re-adapt from base"}
        </Button>
      </div>
      {truncatedNote && <p className="text-xs text-status-pending">{truncatedNote}</p>}
      {channel.error && <p className="text-sm text-destructive">{channel.error}</p>}
      {channel.warning && <p className="text-sm text-status-pending">{channel.warning}</p>}
      {channel.status === "queued" && !channel.warning && (
        <p className="text-sm text-status-success">Queued in Buffer.</p>
      )}
      {channel.status === "failed" && !channel.error && (
        <p className="text-sm text-destructive">Failed to post.</p>
      )}
    </div>
  );
}
