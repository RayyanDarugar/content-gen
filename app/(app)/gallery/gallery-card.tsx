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
import type { IdeaWithGenerations } from "./page";

const statusVariant: Record<string, "pending" | "success" | "destructive" | "outline"> = {
  submitted: "pending", polling: "pending", succeeded: "success", failed: "destructive",
};

export function GalleryCard({ idea }: { idea: IdeaWithGenerations }) {
  const latest = idea.generations[0];
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const router = useRouter();

  async function submit(refinementNotes?: string) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/images/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId: idea.id, refinementNotes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      if (json.failed > 0) throw new Error(json.errors?.[0] ?? "submit failed");
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
        {latest.status === "succeeded" && latest.public_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={latest.public_url} alt={idea.concept.slice(0, 80)}
            className="h-full w-full object-cover" />
        ) : latest.status === "failed" ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-destructive/10 p-4 text-center">
            <TriangleAlert className="size-6 text-destructive" />
            <p className="text-xs text-destructive break-words line-clamp-3">
              {latest.error || "failed"}
            </p>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-status-pending/10">
            <Loader2 className="size-6 animate-spin text-status-pending" />
            <p className="text-xs text-muted-foreground">polls: {latest.poll_count}</p>
          </div>
        )}
        <Badge
          variant={statusVariant[latest.status] ?? "outline"}
          className="absolute top-2 right-2 backdrop-blur-sm bg-background/70"
        >
          {latest.status}
        </Badge>
      </div>
      <CardContent className="space-y-2 pt-3 pb-4">
        <p className="text-xs text-muted-foreground line-clamp-2">{idea.concept}</p>
        {latest.refinement_notes && (
          <p className="text-xs text-muted-foreground">Notes: {latest.refinement_notes}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {latest.status === "failed" && (
            <Button size="sm" variant="outline" className="rounded-full" disabled={busy} onClick={() => submit()}>
              Retry
            </Button>
          )}
          {latest.status === "succeeded" && (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger render={<Button size="sm" variant="outline" className="rounded-full" />}>
                Regenerate…
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Regenerate with notes</DialogTitle>
                </DialogHeader>
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
          {idea.generations.length > 1 && (
            <Dialog>
              <DialogTrigger
                render={<button className="text-xs underline text-muted-foreground" />}
              >
                history ({idea.generations.length})
              </DialogTrigger>
              <DialogContent className="max-h-[80vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Generation history</DialogTitle></DialogHeader>
                {idea.generations.map((g) => (
                  <div key={g.id} className="space-y-1 border-b pb-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant[g.status] ?? "outline"}>{g.status}</Badge>
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
