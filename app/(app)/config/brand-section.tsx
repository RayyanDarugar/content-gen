"use client";
import { useActionState, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { saveBrandProfile } from "./actions";
import type { BrandProfile } from "@/lib/types";
import { BrandListEditor } from "./brand-list-editor";
import { BrandExtractPanel, type BrandDraft } from "./brand-extract-panel";

interface TextFields {
  business_name: string;
  business_description: string;
  audience: string;
  voice: string;
  avoid: string;
}

function ProposalRow({ value, onUse, onKeep }: { value: string; onUse(): void; onKeep(): void }) {
  return (
    <div className="mt-1 flex items-start gap-2 rounded-md border border-dashed border-amber-500/50 p-2 text-xs">
      <span className="flex-1 text-muted-foreground">From extraction: &ldquo;{value}&rdquo;</span>
      <Button type="button" size="xs" variant="outline" onClick={onUse}>Use</Button>
      <Button type="button" size="xs" variant="ghost" onClick={onKeep}>Keep</Button>
    </div>
  );
}

// Case-insensitive, trimmed merge: items already present are kept as-is,
// new ones are appended. Returns which incoming items actually landed so
// the caller can surface an "added, not yet saved" marker for them.
function mergeList(existing: string[], incoming: string[]): { merged: string[]; added: string[] } {
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
  const added: string[] = [];
  for (const raw of incoming) {
    const item = raw.trim();
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    added.push(item);
  }
  return { merged: [...existing, ...added], added };
}

export function BrandSection({ brand }: { brand: BrandProfile | null }) {
  const [state, action, pending] = useActionState(saveBrandProfile, undefined);
  const [fields, setFields] = useState<TextFields>({
    business_name: brand?.business_name ?? "",
    business_description: brand?.business_description ?? "",
    audience: brand?.audience ?? "",
    voice: brand?.voice ?? "",
    avoid: brand?.avoid ?? "",
  });
  const [proposals, setProposals] = useState<Partial<TextFields>>({});
  const [proofPoints, setProofPoints] = useState<string[]>(brand?.proof_points ?? []);
  const [standing, setStanding] = useState<string[]>(brand?.standing ?? []);
  const [addedProof, setAddedProof] = useState<string[]>([]);
  const [addedStanding, setAddedStanding] = useState<string[]>([]);

  // "Added, not yet saved" is staged UI state — clear it the moment a save
  // is actually submitted (a plain form event, not an effect reacting to
  // the action's result) so the form reads as settled again once it lands.
  function onSubmit() {
    setAddedProof([]);
    setAddedStanding([]);
  }

  function set<K extends keyof TextFields>(key: K, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  // A field whose current value is empty just gets filled. A field that
  // already has a different hand-written value is never overwritten
  // silently — it's staged as a proposal until the user picks Use or Keep.
  function propose<K extends keyof TextFields>(key: K, value: string) {
    const trimmed = value.trim();
    if (!trimmed || fields[key].trim() === trimmed) return;
    if (!fields[key].trim()) set(key, trimmed);
    else setProposals((p) => ({ ...p, [key]: trimmed }));
  }

  function applyProposal<K extends keyof TextFields>(key: K) {
    const value = proposals[key];
    if (value === undefined) return;
    set(key, value);
    setProposals((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
  }

  function keepProposal<K extends keyof TextFields>(key: K) {
    setProposals((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
  }

  function onDraft(draft: BrandDraft) {
    propose("business_name", draft.business_name);
    propose("business_description", draft.business_description);
    propose("audience", draft.audience);
    propose("voice", draft.voice);
    propose("avoid", draft.avoid);
    setProofPoints((existing) => {
      const { merged, added } = mergeList(existing, draft.proof_points);
      if (added.length) setAddedProof((prev) => [...prev, ...added]);
      return merged;
    });
    setStanding((existing) => {
      const { merged, added } = mergeList(existing, draft.standing);
      if (added.length) setAddedStanding((prev) => [...prev, ...added]);
      return merged;
    });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Brand</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <BrandExtractPanel onDraft={onDraft} />
        <form action={action} onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label>Business name</Label>
            <Input name="business_name" value={fields.business_name} onChange={(e) => set("business_name", e.target.value)} />
            {proposals.business_name !== undefined && (
              <ProposalRow
                value={proposals.business_name}
                onUse={() => applyProposal("business_name")}
                onKeep={() => keepProposal("business_name")}
              />
            )}
          </div>
          <div>
            <Label>What the business is</Label>
            <Textarea
              name="business_description"
              rows={3}
              value={fields.business_description}
              onChange={(e) => set("business_description", e.target.value)}
            />
            {proposals.business_description !== undefined && (
              <ProposalRow
                value={proposals.business_description}
                onUse={() => applyProposal("business_description")}
                onKeep={() => keepProposal("business_description")}
              />
            )}
          </div>
          <div>
            <Label>Target audience</Label>
            <Input name="audience" value={fields.audience} onChange={(e) => set("audience", e.target.value)} />
            {proposals.audience !== undefined && (
              <ProposalRow
                value={proposals.audience}
                onUse={() => applyProposal("audience")}
                onKeep={() => keepProposal("audience")}
              />
            )}
          </div>
          <div>
            <Label>Voice / tone</Label>
            <Input name="voice" value={fields.voice} onChange={(e) => set("voice", e.target.value)} />
            {proposals.voice !== undefined && (
              <ProposalRow
                value={proposals.voice}
                onUse={() => applyProposal("voice")}
                onKeep={() => keepProposal("voice")}
              />
            )}
          </div>
          <div>
            <Label>Never lead with / avoid</Label>
            <Textarea name="avoid" rows={2} value={fields.avoid} onChange={(e) => set("avoid", e.target.value)} />
            {proposals.avoid !== undefined && (
              <ProposalRow
                value={proposals.avoid}
                onUse={() => applyProposal("avoid")}
                onKeep={() => keepProposal("avoid")}
              />
            )}
          </div>

          <BrandListEditor
            label="Proof points"
            hint="Concrete numbers, names, results — what makes this credible."
            items={proofPoints}
            onChange={setProofPoints}
          />
          {addedProof.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Added from extraction: {addedProof.join(", ")} — save to keep.
            </p>
          )}

          <BrandListEditor
            label="Standing"
            hint="Awards, press mentions, credentials, years in business."
            items={standing}
            onChange={setStanding}
          />
          {addedStanding.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Added from extraction: {addedStanding.join(", ")} — save to keep.
            </p>
          )}

          <input type="hidden" name="proof_points" value={JSON.stringify(proofPoints)} readOnly />
          <input type="hidden" name="standing" value={JSON.stringify(standing)} readOnly />

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save brand"}</Button>
            {state?.ok && <span className="text-sm text-status-success">Saved.</span>}
            {state?.error && <span className="text-sm text-destructive">{state.error}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
