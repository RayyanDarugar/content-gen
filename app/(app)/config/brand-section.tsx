"use client";
import { useActionState, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { saveBrandProfile } from "./actions";
import type { BrandProfile } from "@/lib/types";
import { mergeList } from "@/lib/brand";
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

export function BrandSection({
  brand,
  onSaved,
}: {
  brand: BrandProfile | null;
  /**
   * Fired on a successful save, in addition to this component's own
   * "Saved." message. `saveBrandProfile`'s `revalidatePath("/config")` only
   * refreshes the /config route's server data — a caller mounting this
   * section elsewhere (e.g. /onboarding) needs its own way to learn the
   * brand row changed, since the parent server component won't otherwise
   * re-render with fresh data until the next navigation.
   */
  onSaved?(): void;
}) {
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

  // "Added, not yet saved" must clear on a SUCCESSFUL save, not merely on
  // submit — an onSubmit handler would clear it the instant Save is clicked,
  // before the server action resolves, so a failed save would silently drop
  // the "not yet saved" signal even though nothing persisted. Reacting to
  // `state` (the useActionState result) from a useEffect is the natural fit,
  // but this project's `react-hooks/set-state-in-effect` rule disallows a
  // direct setState call in an effect body. Adjusting state during render by
  // comparing against the previous render's value — React's documented
  // alternative to an effect for this exact case — satisfies it instead.
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setAddedProof([]);
      setAddedStanding([]);
    }
  }

  // A real effect (not the render-phase adjustment above) because this calls
  // a caller-supplied function, not one of this component's own setters —
  // the `react-hooks/set-state-in-effect` rule that forced the pattern above
  // doesn't apply here, and a genuine side effect (asking the router to
  // refetch this route's server data) belongs in an effect, not render.
  useEffect(() => {
    if (state?.ok) onSaved?.();
  }, [state, onSaved]);

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

  // Deleting an item via BrandListEditor's × shouldn't leave it named in the
  // "added from extraction" summary — filter the tracked additions down to
  // whatever is still actually present in the list being rendered.
  const visibleAddedProof = addedProof.filter((item) => proofPoints.includes(item));
  const visibleAddedStanding = addedStanding.filter((item) => standing.includes(item));

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Brand</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <BrandExtractPanel onDraft={onDraft} />
        <form action={action} className="space-y-3">
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
          {visibleAddedProof.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Added from extraction: {visibleAddedProof.join(", ")} — save to keep.
            </p>
          )}

          <BrandListEditor
            label="Standing"
            hint="Awards, press mentions, credentials, years in business."
            items={standing}
            onChange={setStanding}
          />
          {visibleAddedStanding.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Added from extraction: {visibleAddedStanding.join(", ")} — save to keep.
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
