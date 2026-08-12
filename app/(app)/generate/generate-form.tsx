"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { Category } from "@/lib/types";

export interface GenerateResult {
  inserted: number;
  rejectedByFilter?: number;
  droppedForShape?: number;
  filterFailed?: boolean;
  filteredOut?: number;
}

// The two ways an idea disappears need different fixes — the reviewer
// rejecting it is a brand/style-guide problem, malformed slides are a prompt
// problem — so name them separately rather than summing them into one number.
export function describeResult(r: GenerateResult): string {
  const parts: string[] = [];
  if (r.rejectedByFilter) parts.push(`${r.rejectedByFilter} rejected by the quality filter`);
  if (r.droppedForShape) parts.push(`${r.droppedForShape} malformed`);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  const caveat = r.filterFailed
    ? " The quality filter errored, so these were kept without review."
    : "";
  return `Inserted ${r.inserted} idea${r.inserted === 1 ? "" : "s"}${detail}.${caveat}`;
}

export function GenerateForm({ categories }: { categories: Pick<Category, "key" | "name">[] }) {
  const [categoryKey, setCategoryKey] = useState("ALL");
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const router = useRouter();

  async function generate() {
    setBusy(true); setResult(null);
    try {
      const res = await fetch("/api/ideas/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryKey, count }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setResult(describeResult(json));
      router.refresh();
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Category</Label>
        <Select value={categoryKey} onValueChange={(v) => v && setCategoryKey(v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.key} value={c.key}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Number of ideas (max 10 recommended)</Label>
        <Input type="number" min={1} max={20} value={count}
          onChange={(e) => setCount(Number(e.target.value))} />
      </div>
      <Button onClick={generate} disabled={busy} className="w-full">
        {busy ? "Generating… (can take a minute)" : "Generate"}
      </Button>
      {result && <p className="text-sm">{result}</p>}
    </div>
  );
}
