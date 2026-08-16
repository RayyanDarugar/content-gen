"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandSection } from "../config/brand-section";
import { KeysSection } from "../config/keys-section";
import { saveBrandProfile, createBrandAction } from "../config/actions";
import { onboardingStepStates, type StepState } from "@/lib/onboarding";
import type { BrandProfile } from "@/lib/types";

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
  const dimmed = state === "upcoming" || state === "locked";
  return (
    <div className={`rounded-xl border p-4 ${dimmed ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-3">
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            state === "done" ? "bg-status-success/15 text-status-success" : "bg-muted text-muted-foreground"
          }`}
        >
          {state === "done" ? <Check className="size-3.5" /> : state === "locked" ? <Lock className="size-3" /> : index}
        </span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      {/* A locked step's controls are not rendered at all, rather than merely
          dimmed. Every one of them calls an endpoint that fails without an
          Anthropic key, so leaving them clickable is what produced the
          "add your key in Config" dead end this flow now prevents. */}
      {state === "locked" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Add your Anthropic key above to unlock this step.
        </p>
      ) : (
        state !== "done" && <div className="mt-4">{children}</div>
      )}
    </div>
  );
}

export function OnboardingSteps({
  brand,
  keyStatus,
  brandDone,
  categoryDone,
  ideasDone,
  firstCategoryKey,
  creatingBrand = false,
}: {
  brand: BrandProfile | null;
  keyStatus: { anthropic: boolean; kie: boolean };
  brandDone: boolean;
  categoryDone: boolean;
  ideasDone: boolean;
  firstCategoryKey: string | null;
  /**
   * True when this page was reached via /onboarding?new=1 (Config's "Add
   * brand" link) rather than the account's own zero-brand setup flow. The
   * brand-scoped steps below must track the NEW brand's progress, not
   * whatever the currently-active brand already has — brandDone/categoryDone
   * /ideasDone are forced false by the page in this mode, and the brand form
   * here posts to createBrandAction (creates a row) instead of
   * saveBrandProfile (edits the active brand's row). The keys step is
   * deliberately exempt: API keys are account-level, so an account reaching
   * this mode has already satisfied it and step 1 correctly reads done.
   */
  creatingBrand?: boolean;
}) {
  const router = useRouter();
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");

  const states = onboardingStepStates({
    keysDone: keyStatus.anthropic,
    brandDone,
    categoryDone,
    ideasDone,
  });

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
      <StepShell index={1} title="AI keys" state={states[0]}>
        <p className="mb-3 text-sm text-muted-foreground">
          The engine runs on your own API keys — nothing below this step works without the Anthropic one.
        </p>
        <KeysSection status={keyStatus} onSaved={() => router.refresh()} />
      </StepShell>

      <StepShell index={2} title="Brand" state={states[1]}>
        <BrandSection
          brand={creatingBrand ? null : brand}
          action={creatingBrand ? createBrandAction : saveBrandProfile}
          onSaved={() => {
            // Leave create mode once the brand exists, or creatingBrand stays
            // true, the checklist stays pinned at the brand step, and the next
            // submit creates a SECOND brand. createBrandAction has already
            // made this brand active.
            if (creatingBrand) router.replace("/onboarding");
            else router.refresh();
          }}
        />
      </StepShell>

      <StepShell index={3} title="First post type" state={states[2]}>
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

      <StepShell index={4} title="First ideas" state={states[3]}>
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
