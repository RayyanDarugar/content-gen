"use client";
import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  createCategory, updateCategory, deleteCategory, uploadStyleRefImage,
  type CategoryFields,
} from "./actions";
import type { Category } from "@/lib/types";

const EMPTY: CategoryFields = {
  name: "", style_guide: "", output_format: "", style_ref_url: "",
  images_per_carousel: 5, aspect_ratio: "4:5", active: true,
};

function CategoryEditor({ category }: { category?: Category }) {
  const router = useRouter();
  const [form, setForm] = useState<CategoryFields>(
    category
      ? {
          name: category.name, style_guide: category.style_guide,
          output_format: category.output_format, style_ref_url: category.style_ref_url,
          images_per_carousel: category.images_per_carousel,
          aspect_ratio: category.aspect_ratio, active: category.active,
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
        if (category) await updateCategory(category.id, form);
        else { await createCategory(form); setForm(EMPTY); }
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
            <Button variant="destructive" size="sm" disabled={pending} onClick={remove}>Delete</Button>
          )}
        </div>
      </div>
      <div><Label>Style guide</Label>
        <Textarea rows={8} value={form.style_guide} onChange={(e) => set("style_guide", e.target.value)} /></div>
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
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending || uploading}>
          {pending ? "Saving…" : category ? "Save" : "Add category"}
        </Button>
        <span className="text-sm text-muted-foreground">{msg}</span>
      </div>
    </div>
  );
}

export function CategoryManager({ categories }: { categories: Category[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Categories</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {categories.map((c) => <CategoryEditor key={c.id} category={c} />)}
        <div>
          <p className="mb-2 text-sm font-medium">Add a new category</p>
          <CategoryEditor />
        </div>
      </CardContent>
    </Card>
  );
}
