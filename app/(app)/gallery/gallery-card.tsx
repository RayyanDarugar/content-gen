"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import type { IdeaWithGenerations } from "./page";

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  submitted: "outline", polling: "secondary", succeeded: "default", failed: "destructive",
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
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <Badge variant={statusVariant[latest.status] ?? "outline"}>{latest.status}</Badge>
        <div className="flex gap-2">
          {latest.status === "failed" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => submit()}>
              Retry
            </Button>
          )}
          {latest.status === "succeeded" && (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger render={<Button size="sm" variant="outline" />}>
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
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {latest.status === "succeeded" && latest.public_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={latest.public_url} alt={idea.concept.slice(0, 80)}
            className="w-full rounded border object-cover" />
        ) : latest.status === "failed" ? (
          <p className="text-sm text-red-500 break-words">{latest.error || "failed"}</p>
        ) : (
          <p className="text-sm text-muted-foreground animate-pulse">
            Generating… (polls: {latest.poll_count})
          </p>
        )}
        <p className="text-xs text-muted-foreground line-clamp-2">{idea.concept}</p>
        {latest.refinement_notes && (
          <p className="text-xs text-muted-foreground">Notes: {latest.refinement_notes}</p>
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
                    <img src={g.public_url} alt="" className="h-40 rounded border object-cover" />
                  )}
                  {g.refinement_notes && (
                    <p className="text-xs text-muted-foreground">Notes: {g.refinement_notes}</p>
                  )}
                  {g.error && <p className="text-xs text-red-500">{g.error}</p>}
                </div>
              ))}
            </DialogContent>
          </Dialog>
        )}
        {msg && <p className="text-xs text-red-500">{msg}</p>}
      </CardContent>
    </Card>
  );
}
