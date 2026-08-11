"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { createOverlay, deleteOverlay, updateOverlay, uploadStyleRefImage } from "./actions";
import { validateOverlayFields, type OverlayFields } from "@/lib/overlays";
import type { CategoryOverlay, OverlayCorner } from "@/lib/types";

// Sentinel editingId for an unsaved draft (never collides with a uuid), so
// the whole section — saved rows and the in-progress add — is tracked by one
// state variable, as the design calls for.
const NEW_ID = "__new__";

const CORNERS: OverlayCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right", "center"];
const ROLES: OverlayFields["roles"] = ["hook", "beat", "payoff", "single"];

// Mirrors migration 0021's column defaults. No roles selected on purpose —
// validateOverlayFields requires at least one, which nudges the user to pick
// where the asset actually appears rather than silently defaulting it.
const DRAFT_DEFAULTS: OverlayFields = {
  name: "",
  image_url: "",
  roles: [],
  corner: "bottom-right",
  margin_pct: 5,
  size_pct: 15,
  opacity: 100,
  sort_order: 0,
  active: true,
};

function toFields(o: CategoryOverlay): OverlayFields {
  return {
    name: o.name,
    image_url: o.image_url,
    roles: o.roles,
    corner: o.corner,
    margin_pct: o.margin_pct,
    size_pct: o.size_pct,
    opacity: o.opacity,
    sort_order: o.sort_order,
    active: o.active,
  };
}

function OverlayRowCollapsed({ overlay, onEdit }: { overlay: CategoryOverlay; onEdit: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={overlay.image_url}
        alt={overlay.name}
        className="size-10 shrink-0 rounded border object-contain"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{overlay.name}</p>
        {/* The point of this treatment: answers "what's on my payoff slide?"
            without opening the row. */}
        <p className="truncate text-xs text-muted-foreground">
          {overlay.roles.join(", ")} · {overlay.corner} · {overlay.size_pct}%
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onEdit}>Edit</Button>
    </div>
  );
}

function OverlayEditor({
  categoryId,
  overlayId,
  initial,
  onCancel,
  onSaved,
  onDeleted,
}: {
  categoryId: string;
  overlayId: string | null;
  initial: OverlayFields;
  onCancel: () => void;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState<OverlayFields>(initial);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function set<K extends keyof OverlayFields>(k: K, v: OverlayFields[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function toggleRole(role: OverlayFields["roles"][number]) {
    setForm((f) => ({
      ...f,
      roles: f.roles.includes(role) ? f.roles.filter((r) => r !== role) : [...f.roles, role],
    }));
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setMsg("");
    const fd = new FormData();
    fd.append("file", file);
    const res = await uploadStyleRefImage(fd);
    setUploading(false);
    if (res.error) { setMsg(`Upload failed: ${res.error}`); return; }
    if (res.url) set("image_url", res.url);
  }

  function save() {
    setMsg("");
    try {
      validateOverlayFields(form);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      return;
    }
    startTransition(async () => {
      try {
        if (overlayId) await updateOverlay(overlayId, form);
        else await createOverlay(categoryId, form);
        router.refresh();
        onSaved();
      } catch (e) {
        setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  function remove() {
    if (!overlayId) return;
    startTransition(async () => {
      try {
        await deleteOverlay(overlayId);
        router.refresh();
        onDeleted?.();
      } catch (e) {
        setMsg(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-primary bg-primary/5 p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <Label>Name</Label>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Logo" />
        </div>
        <div className="flex-1">
          <Label>Image</Label>
          <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="block text-sm" />
          {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
          {form.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={form.image_url}
              alt={form.name || "overlay"}
              className="mt-2 h-16 w-16 rounded border object-contain"
            />
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Upload the exact image to composite.</p>
          )}
        </div>
      </div>

      <div>
        <Label>Appears on</Label>
        <div className="mt-1 flex flex-wrap gap-2">
          {ROLES.map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => toggleRole(role)}
              className={`rounded-full px-3 py-1 text-sm capitalize transition-colors ${
                form.roles.includes(role)
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {role}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div>
          <Label>Corner</Label>
          <select
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            value={form.corner}
            onChange={(e) => set("corner", e.target.value as OverlayCorner)}
          >
            {CORNERS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <Label>Margin %</Label>
          <Input type="number" min={0} max={49} value={form.margin_pct}
            onChange={(e) => set("margin_pct", Number(e.target.value))} />
        </div>
        <div>
          <Label>Size %</Label>
          <Input type="number" min={1} max={100} value={form.size_pct}
            onChange={(e) => set("size_pct", Number(e.target.value))} />
        </div>
        <div>
          <Label>Opacity %</Label>
          <Input type="number" min={0} max={100} value={form.opacity}
            onChange={(e) => set("opacity", Number(e.target.value))} />
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="w-32">
          <Label>Sort order</Label>
          <Input type="number" value={form.sort_order}
            onChange={(e) => set("sort_order", Number(e.target.value))} />
        </div>
        <div className="flex items-center gap-2 pt-5">
          <Switch checked={form.active} onCheckedChange={(v) => set("active", v)} />
          <span className="text-sm text-muted-foreground">Active</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending || uploading}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>Cancel</Button>
        {overlayId && (
          <Button variant="destructive" size="sm" disabled={pending} onClick={remove}>Delete</Button>
        )}
        <span className="text-sm text-muted-foreground">{msg}</span>
      </div>
    </div>
  );
}

export function OverlaySection({
  categoryId,
  overlays,
}: {
  categoryId: string;
  overlays: CategoryOverlay[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Label>Overlays (logos, QR codes)</Label>
      <p className="text-xs text-muted-foreground">
        Exact assets composited onto finished slides after generation — a logo or QR code,
        placed by role and corner.
      </p>

      {overlays.length === 0 && editingId !== NEW_ID && (
        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          No overlays yet. Add a logo or QR code to appear on this post type&apos;s slides.
        </div>
      )}

      <div className="space-y-2">
        {overlays.map((o) =>
          editingId === o.id ? (
            <OverlayEditor
              key={o.id}
              categoryId={categoryId}
              overlayId={o.id}
              initial={toFields(o)}
              onCancel={() => setEditingId(null)}
              onSaved={() => setEditingId(null)}
              onDeleted={() => setEditingId(null)}
            />
          ) : (
            <OverlayRowCollapsed key={o.id} overlay={o} onEdit={() => setEditingId(o.id)} />
          ),
        )}
        {editingId === NEW_ID && (
          <OverlayEditor
            key="new"
            categoryId={categoryId}
            overlayId={null}
            initial={DRAFT_DEFAULTS}
            onCancel={() => setEditingId(null)}
            onSaved={() => setEditingId(null)}
          />
        )}
      </div>

      {editingId !== NEW_ID && (
        <Button type="button" variant="outline" size="sm" onClick={() => setEditingId(NEW_ID)}>
          + Add overlay
        </Button>
      )}
    </div>
  );
}
