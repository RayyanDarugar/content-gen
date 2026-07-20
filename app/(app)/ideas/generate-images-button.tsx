"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function GenerateImagesButton({ ideaIds }: { ideaIds: string[] }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const router = useRouter();

  async function submit() {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/images/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaIds }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setMsg(`Submitted ${json.submitted}${json.failed ? `, ${json.failed} failed` : ""}.`);
      router.refresh();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      <Button size="sm" onClick={submit} disabled={busy}>
        {busy ? "Submitting…" : `Generate images (${ideaIds.length})`}
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}
