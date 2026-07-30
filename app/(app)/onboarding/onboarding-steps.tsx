"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandSection } from "../config/brand-section";
import type { BrandProfile } from "@/lib/types";

type StepState = "done" | "current" | "upcoming";

function StepShell({
  index,
  title,
  state,
  children,
}: {
  index: number;
  title: string;
  state: StepState;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border p-4 ${state === "upcoming" ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-3">
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            state === "done" ? "bg-status-success/15 text-status-success" : "bg-muted text-muted-foreground"
          }`}
        >
          {state === "done" ? <Check className="size-3.5" /> : index}
        </span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      {state !== "done" && <div className="mt-4">{children}</div>}
    </div>
  );
}

export function OnboardingSteps({
  brand,
  brandDone,
  categoryDone,
  ideasDone,
  firstCategoryKey,
}: {
  brand: BrandProfile | null;
  brandDone: boolean;
  categoryDone: boolean;
  ideasDone: boolean;
  firstCategoryKey: string | null;
}) {
  const router = useRouter();
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");

  const doneFlags = [brandDone, categoryDone, ideasDone];
  const firstIncomplete = doneFlags.findIndex((done) => !done);
  const states: StepState[] = doneFlags.map((done, i) =>
    done ? "done" : i === firstIncomplete ? "current" : "upcoming",
  );

  async function generateIdeas() {
    if (!firstCategoryKey) return;
    setGenBusy(true);
    setGenError("");
    try {
      const res = await fetch("/api/ideas/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryKey: firstCategoryKey, count: 5 }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? res.statusText);
      router.push("/ideas");
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <StepShell index={1} title="Brand" state={states[0]}>
        <BrandSection brand={brand} onSaved={() => router.refresh()} />
      </StepShell>

      <StepShell index={2} title="First post type" state={states[1]}>
        <p className="mb-3 text-sm text-muted-foreground">
          Draft a post type — it opens the same wizard you&apos;ll reuse later from Config.
        </p>
        <div className="flex flex-wrap gap-2">
          {brandDone && (
            <Button render={<Link href="/config/draft?suggest=1" />}>Suggest one for me</Button>
          )}
          <Button render={<Link href="/config/draft" />} variant={brandDone ? "outline" : undefined}>
            Build my own
          </Button>
        </div>
        {!brandDone && (
          <p className="mt-2 text-xs text-muted-foreground">
            Finish brand setup above and we can suggest a post type built on it.
          </p>
        )}
      </StepShell>

      <StepShell index={3} title="First ideas" state={states[2]}>
        <p className="mb-3 text-sm text-muted-foreground">
          Generate five ideas from your first post type to see the pipeline work end to end.
        </p>
        <Button onClick={generateIdeas} disabled={!categoryDone || genBusy}>
          {genBusy ? "Generating…" : "Generate 5 ideas"}
        </Button>
        {genError && <p className="mt-2 text-sm text-destructive">{genError}</p>}
      </StepShell>

      <Link href="/ideas" className="inline-block text-sm text-muted-foreground underline-offset-4 hover:underline">
        Skip for now
      </Link>
    </div>
  );
}
