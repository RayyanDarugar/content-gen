"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createManualIdea } from "./actions";
import type { Category, Slide } from "@/lib/types";

const ROLES: Slide["role"][] = ["hook", "beat", "payoff", "single"];

// hook / beat... / payoff for a carousel, one `single` for a one-image post,
// so the common case needs no editing before saving.
function defaultSlides(count: number): Slide[] {
  if (count <= 1) return [{ role: "single", text: "", visual: "" }];
  return Array.from({ length: count }, (_, i) => ({
    role: i === 0 ? "hook" : i === count - 1 ? "payoff" : "beat",
    text: "",
    visual: "",
  }));
}

// Only a narrative category's default fill is a multi-slide story. An
// independent category defaults to one standalone image regardless of its
// images_per_carousel — that field means something else for it (how many
// unrelated images make up a post). Without this branch, picking an
// independent category like SAT_MYTH still pre-filled a chained five-panel
// carousel shape, reproducing the bug this whole change exists to fix.
function defaultSlidesForCategory(cat: Category | undefined): Slide[] {
  return defaultSlides(cat?.post_type === "narrative" ? cat.images_per_carousel : 1);
}

export function ManualIdeaDialog({ categories }: { categories: Category[] }) {
  const [open, setOpen] = useState(false);
  const [categoryKey, setCategoryKey] = useState(categories[0]?.key ?? "");
  const [concept, setConcept] = useState("");
  const [slides, setSlides] = useState<Slide[]>(defaultSlidesForCategory(categories[0]));
  const [busy, setBusy] = useState(false);

  function pickCategory(key: string) {
    setCategoryKey(key);
    const cat = categories.find((c) => c.key === key);
    setSlides(defaultSlidesForCategory(cat));
  }

  function updateSlide(index: number, patch: Partial<Slide>) {
    setSlides((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function save() {
    setBusy(true);
    try {
      await createManualIdea({ categoryKey, concept, slides });
      toast.success("Idea created");
      setOpen(false);
      setConcept("");
      const cat = categories.find((c) => c.key === categoryKey);
      setSlides(defaultSlidesForCategory(cat));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create idea");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" className="rounded-full" />}>
        Add manually
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>New idea</DialogTitle></DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Category</Label>
            <select
              className="w-full rounded-md border bg-transparent px-3 py-2"
              value={categoryKey}
              onChange={(e) => pickCategory(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.key} value={c.key}>{c.key}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>Concept</Label>
            <Input
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              placeholder="One line summarising the story this tells"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Slides ({slides.length})</Label>
              <div className="flex gap-2">
                <Button
                  type="button" variant="outline" size="sm" className="rounded-full"
                  onClick={() =>
                    setSlides((p) => [...p, { role: "beat", text: "", visual: "" }])}
                >
                  Add slide
                </Button>
                <Button
                  type="button" variant="outline" size="sm" className="rounded-full"
                  disabled={slides.length <= 1}
                  onClick={() => setSlides((p) => p.slice(0, -1))}
                >
                  Remove last
                </Button>
              </div>
            </div>

            {slides.map((slide, i) => (
              <div key={i} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">{i + 1}</span>
                  <select
                    className="rounded-md border bg-transparent px-2 py-1 text-sm"
                    value={slide.role}
                    onChange={(e) =>
                      updateSlide(i, { role: e.target.value as Slide["role"] })}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <Input
                  value={slide.text}
                  onChange={(e) => updateSlide(i, { text: e.target.value })}
                  placeholder="Text on the panel"
                />
                <textarea
                  className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
                  rows={2}
                  value={slide.visual}
                  onChange={(e) => updateSlide(i, { visual: e.target.value })}
                  placeholder="Scene, camera angle, pose"
                />
              </div>
            ))}
          </div>

          <Button onClick={save} disabled={busy || !concept.trim()} className="rounded-full">
            {busy ? "Creating…" : "Create idea"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
