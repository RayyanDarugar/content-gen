"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { buildSlideView } from "@/lib/athena/slide-view";
import type { Generation } from "@/lib/types";
import type { IdeaWithGenerations } from "./page";

const statusVariant: Record<string, "pending" | "success" | "destructive" | "outline"> = {
  submitted: "pending", polling: "pending", succeeded: "success", failed: "destructive",
};

function SlideImage({ gen, alt }: { gen: Generation | null; alt: string }) {
  if (!gen) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/40">
        <p className="text-xs text-muted-foreground">not started</p>
      </div>
    );
  }
  if (gen.status === "succeeded" && gen.public_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={gen.public_url} alt={alt} className="h-full w-full object-cover" />;
  }
  if (gen.status === "failed") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-destructive/10 p-4 text-center">
        <TriangleAlert className="size-6 text-destructive" />
        <p className="text-xs text-destructive break-words line-clamp-3">{gen.error || "failed"}</p>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-status-pending/10">
      <Loader2 className="size-6 animate-spin text-status-pending" />
      <p className="text-xs text-muted-foreground">polls: {gen.poll_count}</p>
    </div>
  );
}

export function GalleryCard({ idea }: { idea: IdeaWithGenerations }) {
  const slideCount = (idea.slides ?? []).length || 1;
  // Siblings of one post, not prior attempts — only genuinely replaced rows
  // belong in history.
  const { slides, superseded } = buildSlideView(idea.generations, slideCount);

  const [active, setActive] = useState(0);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const router = useRouter();

  const current = slides[Math.min(active, slides.length - 1)]?.generation ?? null;
  const anyFailed = slides.some((s) => s.generation?.status === "failed");
  const currentFailed = current?.status === "failed";
  const allSucceeded = slides.every((s) => s.generation?.status === "succeeded");
  const isCarousel = slideCount > 1;

  // slideIndex retries just that panel against the anchor its siblings used.
  // Omitting it re-anchors and regenerates the whole carousel — which is right
  // for a failed opener or a deliberate Regenerate, and wrong for one bad
  // middle slide, where it would spend five generations to recover one and
  // throw away four good images.
  async function submit(refinementNotes?: string, slideIndex?: number) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/images/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId: idea.id, refinementNotes, slideIndex }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      if (json.failed > 0) throw new Error(json.errors?.[0] ?? "submit failed");
      // A skip (idea not currently retryable — e.g. still in flight, or a
      // completed idea with no refinement notes) returns HTTP 200 with
      // submitted: 0. That is not success: nothing happened, so the dialog
      // must not close and refresh as though it worked.
      if ((json.submitted ?? 0) === 0) {
        throw new Error("Nothing was submitted — this idea isn't retryable right now.");
      }
      setDialogOpen(false);
      setNotes("");
      router.refresh();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden py-0 transition-all hover:-translate-y-1 hover:shadow-xl hover:ring-primary/40">
      <div className="relative aspect-square">
        <SlideImage gen={current} alt={idea.concept.slice(0, 80)} />
        <Badge
          variant={statusVariant[current?.status ?? ""] ?? "outline"}
          className="absolute top-2 right-2 backdrop-blur-sm bg-background/70"
        >
          {isCarousel ? `${active + 1}/${slideCount} · ` : ""}{current?.status ?? "pending"}
        </Badge>
      </div>

      {isCarousel && (
        <div className="flex gap-1.5 overflow-x-auto px-3 pt-3">
          {slides.map((slot, i) => (
            <button
              key={slot.slide_index}
              onClick={() => setActive(i)}
              title={`Slide ${i + 1}: ${slot.generation?.status ?? "not started"}`}
              className={`relative aspect-[4/5] w-12 shrink-0 overflow-hidden rounded-md border-2 ${
                i === active ? "border-primary" : "border-transparent opacity-70 hover:opacity-100"
              }`}
            >
              <SlideImage gen={slot.generation} alt={`slide ${i + 1}`} />
              <span className="absolute bottom-0 right-0 bg-background/80 px-1 text-[10px]">
                {i + 1}
              </span>
            </button>
          ))}
        </div>
      )}

      <CardContent className="space-y-2 pt-3 pb-4">
        <p className="text-xs text-muted-foreground line-clamp-2">{idea.concept}</p>
        {current?.refinement_notes && (
          <p className="text-xs text-muted-foreground">Notes: {current.refinement_notes}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {currentFailed && (
            <Button
              size="sm" variant="outline" className="rounded-full" disabled={busy}
              onClick={() => submit(undefined, isCarousel && active > 0 ? active : undefined)}
              title={
                isCarousel && active > 0
                  ? `Regenerate slide ${active + 1} against the opening image`
                  : "The opening image anchors the others, so this regenerates the whole carousel"
              }
            >
              {isCarousel && active > 0 ? `Retry slide ${active + 1}` : isCarousel ? "Retry carousel" : "Retry"}
            </Button>
          )}
          {anyFailed && !currentFailed && (
            <button
              className="text-xs underline text-muted-foreground"
              onClick={() => setActive(slides.findIndex((s) => s.generation?.status === "failed"))}
            >
              go to failed slide
            </button>
          )}
          {allSucceeded && (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger render={<Button size="sm" variant="outline" className="rounded-full" />}>
                Regenerate…
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {isCarousel ? "Regenerate the whole carousel" : "Regenerate with notes"}
                  </DialogTitle>
                </DialogHeader>
                {isCarousel && (
                  <p className="text-xs text-muted-foreground">
                    Every slide is generated against the opening image, so regenerating
                    replaces all {slideCount} — the existing ones stay in history.
                  </p>
                )}
                <Textarea
                  rows={4}
                  placeholder="What should change? (appended to the prompt)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <Button disabled={busy || !notes.trim()} onClick={() => submit(notes.trim())}>
                  {busy ? "Submitting…" : "Regenerate"}
                </Button>
              </DialogContent>
            </Dialog>
          )}
          {superseded.length > 0 && (
            <Dialog>
              <DialogTrigger
                render={<button className="text-xs underline text-muted-foreground" />}
              >
                history ({superseded.length})
              </DialogTrigger>
              <DialogContent className="max-h-[80vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Superseded generations</DialogTitle></DialogHeader>
                {superseded.map((g) => (
                  <div key={g.id} className="space-y-1 border-b pb-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant[g.status] ?? "outline"}>{g.status}</Badge>
                      {slideCount > 1 && (
                        <span className="text-xs text-muted-foreground">slide {g.slide_index + 1}</span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {new Date(g.created_at).toLocaleString()}
                      </span>
                    </div>
                    {g.public_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={g.public_url} alt="" className="h-40 rounded-xl object-cover" />
                    )}
                    {g.refinement_notes && (
                      <p className="text-xs text-muted-foreground">Notes: {g.refinement_notes}</p>
                    )}
                    {g.error && <p className="text-xs text-destructive">{g.error}</p>}
                  </div>
                ))}
              </DialogContent>
            </Dialog>
          )}
        </div>
        {msg && <p className="text-xs text-destructive">{msg}</p>}
      </CardContent>
    </Card>
  );
}
