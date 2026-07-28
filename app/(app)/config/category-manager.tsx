"use client";
import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  createCategory, updateCategory, deleteCategory, uploadStyleRefImage, clearRoleRefUrl,
} from "./actions";
import type { CategoryFields } from "@/lib/categories";
import type { BufferChannel, Category } from "@/lib/types";

const EMPTY: CategoryFields = {
  name: "", style_guide: "", output_format: "", style_ref_url: "",
  post_caption: "", buffer_channel_id: "", caption_guide: "", buffer_channel_service: "",
  images_per_carousel: 5, aspect_ratio: "4:5", active: true,
  post_type: "independent", role_guides: {},
};

function CategoryEditor({ category, channels }: { category?: Category; channels: BufferChannel[] }) {
  const router = useRouter();
  const [form, setForm] = useState<CategoryFields>(
    category
      ? {
          name: category.name, style_guide: category.style_guide,
          output_format: category.output_format, style_ref_url: category.style_ref_url,
          post_caption: category.post_caption, buffer_channel_id: category.buffer_channel_id,
          caption_guide: category.caption_guide, buffer_channel_service: category.buffer_channel_service ?? "",
          images_per_carousel: category.images_per_carousel,
          aspect_ratio: category.aspect_ratio, active: category.active,
          post_type: category.post_type, role_guides: category.role_guides ?? {},
        }
      : EMPTY,
  );
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function set<K extends keyof CategoryFields>(k: K, v: CategoryFields[K]) {
    setForm((f) => ({ ...f, [k]: v }));
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
    if (res.url) set("style_ref_url", res.url);
  }

  function save() {
    startTransition(async () => {
      try {
        // The service is normally captured by the channel dropdown's onChange,
        // but re-saving a pre-existing category without re-picking the channel
        // would otherwise write back whatever was already in form (possibly
        // ''). Re-derive it from the current channel list so it self-heals.
        const service = channels.find((c) => c.id === form.buffer_channel_id)?.service
          ?? form.buffer_channel_service;
        const payload = { ...form, buffer_channel_service: service };
        if (category) await updateCategory(category.id, payload);
        else { await createCategory(payload); setForm(EMPTY); }
        setMsg("Saved.");
        router.refresh();
      } catch (e) {
        setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  function remove() {
    if (!category) return;
    startTransition(async () => {
      try { await deleteCategory(category.id); router.refresh(); }
      catch (e) { setMsg(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
    });
  }

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <Input className="max-w-xs" placeholder="Category name" value={form.name}
          onChange={(e) => set("name", e.target.value)} />
        <div className="flex items-center gap-3">
          <Switch checked={form.active} onCheckedChange={(v) => set("active", v)} />
          {category && (
            <>
              <Button
                render={<Link href={`/config/draft?category=${category.id}`} />}
                variant="outline"
                size="sm"
              >
                Revise with AI
              </Button>
              <Button variant="destructive" size="sm" disabled={pending} onClick={remove}>Delete</Button>
            </>
          )}
        </div>
      </div>
      <div><Label>Post type</Label>
        <select
          className="w-full rounded-md border bg-transparent px-3 py-2"
          value={form.post_type}
          onChange={(e) => set("post_type", e.target.value as CategoryFields["post_type"])}
        >
          <option value="independent">Independent images — each one stands alone</option>
          <option value="narrative">Narrative carousel — one story across the slides</option>
        </select>
        <p className="mt-1 text-xs text-muted-foreground">
          {form.post_type === "narrative"
            ? `Each idea becomes one ${form.images_per_carousel}-slide story: an opener, middle beats, then a closer. Later slides are generated against the opening image so they look like one post.`
            : "Each idea becomes one standalone image. Nothing is chained, and no opener or closer is written."}
        </p>
      </div>

      <div><Label>Style guide (shared by every image)</Label>
        <Textarea rows={8} value={form.style_guide} onChange={(e) => set("style_guide", e.target.value)} /></div>

      {form.post_type === "narrative" && (
        <div className="space-y-2 rounded-lg border p-3">
          <Label>Per-slide treatment</Label>
          <p className="text-xs text-muted-foreground">
            What differs by panel. The style guide above covers what every panel shares —
            palette, character, typography, any footer. Put here only what belongs to one
            role: a tag or strike-through that belongs on the opener, for instance, must be
            named here rather than in the style guide, or it lands on every panel including
            the closer.
          </p>
          {(["hook", "beat", "payoff"] as const).map((role) => (
            <div key={role}>
              <Label className="text-xs capitalize">{role}</Label>
              <Textarea
                rows={2}
                placeholder={
                  role === "hook" ? "e.g. Orange MYTH tag top-left, statement struck through with a hand-drawn X."
                    : role === "beat" ? "e.g. No tag, no X — this panel explains rather than debunks."
                    : "e.g. No tag, no X. The resolved truth, stated clean."
                }
                value={form.role_guides[role] ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  const next = { ...form.role_guides };
                  if (value.trim()) next[role] = value;
                  else delete next[role];
                  set("role_guides", next);
                }}
              />
            </div>
          ))}
        </div>
      )}

      {category && category.role_ref_urls && Object.keys(category.role_ref_urls).length > 0 && (
        <div className="space-y-2 rounded-lg border p-3">
          <Label>Reference images (cemented from test runs)</Label>
          <div className="flex flex-wrap gap-3">
            {Object.entries(category.role_ref_urls).map(([role, url]) => (
              <div key={role} className="w-24 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={`${role} reference`} className="h-24 w-24 rounded border object-cover" />
                <p className="mt-1 text-xs capitalize text-muted-foreground">{role}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1 h-6 px-2 text-xs"
                  disabled={pending}
                  onClick={() => {
                    startTransition(async () => {
                      try {
                        await clearRoleRefUrl(category.id, role as "hook" | "beat" | "payoff" | "single");
                        router.refresh();
                      } catch (e) {
                        setMsg(`Failed to clear ${role} ref: ${e instanceof Error ? e.message : String(e)}`);
                      }
                    });
                  }}
                >
                  Clear
                </Button>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Cleared roles fall back to the brand style reference.
          </p>
        </div>
      )}

      <div><Label>Output format (how ideas in this category are structured)</Label>
        <Textarea rows={3} value={form.output_format} onChange={(e) => set("output_format", e.target.value)} /></div>
      <div><Label>Style reference image</Label>
        <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="block text-sm" />
        {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
        {form.style_ref_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={form.style_ref_url} alt="style ref" className="mt-2 h-40 rounded border object-cover" />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label>Images per carousel</Label>
          <Input type="number" min={1} max={10} value={form.images_per_carousel}
            onChange={(e) => set("images_per_carousel", Number(e.target.value))} /></div>
        <div><Label>Aspect ratio</Label>
          <Input value={form.aspect_ratio} onChange={(e) => set("aspect_ratio", e.target.value)} /></div>
      </div>
      <div><Label>Copy guide (AI-written post text)</Label>
        <p className="text-xs text-muted-foreground">
          Filled in: the AI writes each post&apos;s copy in this voice, shaped for the
          platform of the Buffer channel below. Empty: the rotating captions below
          are used, exactly as before.
        </p>
        <Textarea rows={4} value={form.caption_guide}
          onChange={(e) => set("caption_guide", e.target.value)} /></div>
      <div><Label>Post caption (use || to separate rotating variants)</Label>
        <Textarea rows={3} value={form.post_caption}
          onChange={(e) => set("post_caption", e.target.value)} /></div>
      <div><Label>Buffer channel</Label>
        {channels.length === 0 ? (
          <p className="text-xs text-muted-foreground">Connect Buffer above to choose a channel.</p>
        ) : (
          <select className="block w-full rounded-md border bg-background p-2 text-sm"
            value={form.buffer_channel_id}
            onChange={(e) => {
              const id = e.target.value;
              const service = channels.find((c) => c.id === id)?.service ?? "";
              setForm((f) => ({ ...f, buffer_channel_id: id, buffer_channel_service: service }));
            }}>
            <option value="">— none —</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName || c.name} ({c.service})</option>
            ))}
          </select>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending || uploading}>
          {pending ? "Saving…" : category ? "Save" : "Add category"}
        </Button>
        <span className="text-sm text-muted-foreground">{msg}</span>
      </div>
    </div>
  );
}

export function CategoryManager({ categories, channels }: { categories: Category[]; channels: BufferChannel[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Categories</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {categories.map((c) => <CategoryEditor key={c.id} category={c} channels={channels} />)}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Add a new category</p>
            <Button render={<Link href="/config/draft" />} variant="outline" size="sm">
              ✨ Draft with AI
            </Button>
          </div>
          <CategoryEditor channels={channels} />
        </div>
      </CardContent>
    </Card>
  );
}
