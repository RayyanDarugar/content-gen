"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { uploadStyleRefImage } from "@/app/(app)/config/actions";
import { setOverlayFill, clearOverlayFill } from "./actions";
import type { CategoryOverlay, IdeaOverlayFill } from "@/lib/types";

export function SlotStrip({
  ideaId, slots, fills,
}: {
  ideaId: string;
  slots: CategoryOverlay[];
  fills: IdeaOverlayFill[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busySlot, setBusySlot] = useState("");
  const [msg, setMsg] = useState("");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  if (slots.length === 0) return null;

  const fillBySlot = new Map(fills.map((f) => [f.overlay_id, f]));

  async function onFile(slotId: string, file: File) {
    setBusySlot(slotId);
    setMsg("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const up = await uploadStyleRefImage(fd);
      if (up.error || !up.url) throw new Error(up.error ?? "upload failed");
      // Saving also re-composites any slides this slot appears on.
      await setOverlayFill(ideaId, slotId, up.url);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusySlot("");
    }
  }

  return (
    <div className="mt-2 space-y-2 border-t border-dashed pt-2">
      {slots.map((slot) => {
        const fill = fillBySlot.get(slot.id);
        const busy = busySlot === slot.id || pending;
        return (
          <div key={slot.id} className="flex items-center gap-2">
            {fill ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fill.image_url} alt="" className="size-8 shrink-0 rounded-md object-cover" />
            ) : (
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
                +
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{slot.name}</p>
              <p className="text-[10px] text-muted-foreground">
                {slot.corner} · {slot.size_pct}%
              </p>
            </div>
            <input
              ref={(el) => { inputs.current[slot.id] = el; }}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset so re-picking the same file fires change again.
                e.target.value = "";
                if (file) void onFile(slot.id, file);
              }}
            />
            <Button
              size="xs" variant="outline" disabled={busy}
              onClick={() => inputs.current[slot.id]?.click()}
            >
              {busy ? "Working…" : fill ? "Replace" : "Upload"}
            </Button>
            {fill && (
              <Button
                size="xs" variant="ghost" disabled={busy}
                onClick={() =>
                  startTransition(async () => {
                    await clearOverlayFill(ideaId, slot.id);
                    router.refresh();
                  })
                }
              >
                Remove
              </Button>
            )}
          </div>
        );
      })}
      {msg && <p className="text-xs text-destructive">{msg}</p>}
    </div>
  );
}
