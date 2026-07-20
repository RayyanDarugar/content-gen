"use client";
import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { updateCategory, type CategoryUpdate } from "./actions";
import type { Category } from "@/lib/types";

export function ConfigForm({ category }: { category: Category }) {
  const [form, setForm] = useState<CategoryUpdate>({
    name: category.name,
    style_guide: category.style_guide,
    style_ref_url: category.style_ref_url,
    post_caption: category.post_caption,
    buffer_channel_id: category.buffer_channel_id,
    buffer_account: category.buffer_account,
    images_per_carousel: category.images_per_carousel,
    aspect_ratio: category.aspect_ratio,
    active: category.active,
  });
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");

  function set<K extends keyof CategoryUpdate>(k: K, v: CategoryUpdate[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function save() {
    startTransition(async () => {
      try {
        await updateCategory(category.key, form);
        setMsg("Saved.");
      } catch (e) {
        setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{category.key}</CardTitle>
        <div className="flex items-center gap-3">
          <Switch checked={form.active} onCheckedChange={(v) => { set("active", v); }} />
          <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Edit"}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          <div><Label>Name</Label>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} /></div>
          <div><Label>Style guide</Label>
            <Textarea rows={10} value={form.style_guide}
              onChange={(e) => set("style_guide", e.target.value)} /></div>
          <div><Label>Style reference URL</Label>
            <Input value={form.style_ref_url}
              onChange={(e) => set("style_ref_url", e.target.value)} />
            {form.style_ref_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.style_ref_url} alt="style ref"
                className="mt-2 h-40 rounded border object-cover" />
            )}
          </div>
          <div><Label>Post caption</Label>
            <Textarea rows={3} value={form.post_caption}
              onChange={(e) => set("post_caption", e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Buffer channel ID</Label>
              <Input value={form.buffer_channel_id}
                onChange={(e) => set("buffer_channel_id", e.target.value)} /></div>
            <div><Label>Buffer account (1 or 2)</Label>
              <Input type="number" min={1} max={2} value={form.buffer_account}
                onChange={(e) => set("buffer_account", Number(e.target.value))} /></div>
            <div><Label>Images per carousel</Label>
              <Input type="number" min={1} max={10} value={form.images_per_carousel}
                onChange={(e) => set("images_per_carousel", Number(e.target.value))} /></div>
            <div><Label>Aspect ratio</Label>
              <Input value={form.aspect_ratio}
                onChange={(e) => set("aspect_ratio", e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
            <span className="text-sm text-muted-foreground">{msg}</span>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
