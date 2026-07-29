"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { saveBrandProfile } from "./actions";
import type { BrandProfile } from "@/lib/types";
import { mergeList } from "@/lib/brand";
import { BrandListEditor } from "./brand-list-editor";
import { ColorListEditor } from "./color-list-editor";
import { BrandExtractPanel, type BrandDraft } from "./brand-extract-panel";

interface TextFields {
  business_name: string;
  business_description: string;
  audience: string;
  voice: string;
  avoid: string;
  visual_notes: string;
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
    visual_notes: brand?.visual_notes ?? "",
  });
  const [proposals, setProposals] = useState<Partial<TextFields>>({});
  const [proofPoints, setProofPoints] = useState<string[]>(brand?.proof_points ?? []);
  const [standing, setStanding] = useState<string[]>(brand?.standing ?? []);
  const [colors, setColors] = useState<string[]>(brand?.colors ?? []);
  const [fonts, setFonts] = useState<string[]>(brand?.fonts ?? []);
  const [addedProof, setAddedProof] = useState<string[]>([]);
  const [addedStanding, setAddedStanding] = useState<string[]>([]);
  const [addedColors, setAddedColors] = useState<string[]>([]);
  const [addedFonts, setAddedFonts] = useState<string[]>([]);

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
      setAddedColors([]);
      setAddedFonts([]);
    }
  }

  // A real effect (not the render-phase adjustment above) because this calls
  // a caller-supplied function, not one of this component's own setters —
  // the `react-hooks/set-state-in-effect` rule that forced the pattern above
  // doesn't apply here, and a genuine side effect (asking the router to
  // refetch this route's server data) belongs in an effect, not render.
  //
  // Two things had to be true to avoid a refresh loop when the caller passes
  // an inline callback (as the onboarding wizard does):
  //   1. `onSaved`'s identity must NOT be a dependency. A fresh closure each
  //      render is normal for an inline arrow function; if the effect below
  //      depended on it, every parent re-render (including the one caused BY
  //      calling onSaved -> router.refresh()) would re-run the effect,
  //      independent of whether the save state actually changed — a loop
  //      with no stop condition. Keeping the latest callback in a ref instead
  //      (synced from a dependency-free effect, per React's documented
  //      pattern for this) means only an actual new `state` object can ever
  //      trigger this effect.
  //   2. Firing must key off the TRANSITION to a new successful state, not
  //      "state.ok is currently true" — `state.ok` stays true across
  //      re-renders until the next submit, so anything that reruns this
  //      effect while ok is still true would refire it. `firedForRef` records
  //      which state object has already been handled, so even if the deps
  //      array above were ever widened again by a future edit, this check
  //      alone would still stop a repeat firing for the same result.
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });
  const firedForRef = useRef<typeof state>(undefined);
  useEffect(() => {
    if (state?.ok && firedForRef.current !== state) {
      firedForRef.current = state;
      onSavedRef.current?.();
    }
  }, [state]);

  function set<K extends keyof TextFields>(key: K, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  // Extraction (onDraft, below) is triggered from an async fetch that can
  // take 10-60s to resolve. propose() and onDraft() need to decide against
  // whatever the user has typed by the time the draft actually lands, not
  // against whatever fields/proofPoints/standing were at the moment the
  // request was kicked off — reading those state variables directly here
  // would close over stale render-time values. These refs are mirrored from
  // state on every render (the same pattern this file already uses for
  // onSavedRef below) so async callbacks can read the latest committed
  // value instead.
  const fieldsRef = useRef(fields);
  useEffect(() => {
    fieldsRef.current = fields;
  });
  const proofPointsRef = useRef(proofPoints);
  useEffect(() => {
    proofPointsRef.current = proofPoints;
  });
  const standingRef = useRef(standing);
  useEffect(() => {
    standingRef.current = standing;
  });
  const colorsRef = useRef(colors);
  useEffect(() => {
    colorsRef.current = colors;
  });
  const fontsRef = useRef(fonts);
  useEffect(() => {
    fontsRef.current = fonts;
  });

  // A field whose current value is empty just gets filled. A field that
  // already has a different hand-written value is never overwritten
  // silently — it's staged as a proposal until the user picks Use or Keep.
  // Reads fieldsRef (current), not `fields` (the stale render closure), so a
  // user typing into a field while extraction is in flight doesn't get it
  // silently overwritten once the draft lands.
  function propose<K extends keyof TextFields>(key: K, value: string) {
    const trimmed = value.trim();
    const current = fieldsRef.current[key].trim();
    if (!trimmed || current === trimmed) return;
    if (!current) set(key, trimmed);
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
    propose("visual_notes", draft.visual_notes);

    // mergeList is computed against the CURRENT list (via the ref, not a
    // stale closure) outside of any updater, then the two setters are called
    // separately rather than nesting setAddedProof inside setProofPoints's
    // updater. React requires state updaters to be pure; calling a second
    // setState from inside one is impure and StrictMode's double-invocation
    // (and concurrent re-basing in production) would duplicate entries in
    // the "Added from extraction" summary.
    const proofMerge = mergeList(proofPointsRef.current, draft.proof_points);
    setProofPoints(proofMerge.merged);
    if (proofMerge.added.length) setAddedProof((prev) => [...prev, ...proofMerge.added]);

    const standingMerge = mergeList(standingRef.current, draft.standing);
    setStanding(standingMerge.merged);
    if (standingMerge.added.length) setAddedStanding((prev) => [...prev, ...standingMerge.added]);

    const colorsMerge = mergeList(colorsRef.current, draft.colors);
    setColors(colorsMerge.merged);
    if (colorsMerge.added.length) setAddedColors((prev) => [...prev, ...colorsMerge.added]);

    const fontsMerge = mergeList(fontsRef.current, draft.fonts);
    setFonts(fontsMerge.merged);
    if (fontsMerge.added.length) setAddedFonts((prev) => [...prev, ...fontsMerge.added]);
  }

  // Deleting an item via BrandListEditor's × shouldn't leave it named in the
  // "added from extraction" summary — filter the tracked additions down to
  // whatever is still actually present in the list being rendered.
  const visibleAddedProof = addedProof.filter((item) => proofPoints.includes(item));
  const visibleAddedStanding = addedStanding.filter((item) => standing.includes(item));
  const visibleAddedColors = addedColors.filter((item) => colors.includes(item));
  const visibleAddedFonts = addedFonts.filter((item) => fonts.includes(item));

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Brand</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <BrandExtractPanel onDraft={onDraft} />
        <form action={action} className="space-y-3">
          <div>
            <Label>Business name</Label>
            <Input
              name="business_name"
              required
              value={fields.business_name}
              onChange={(e) => set("business_name", e.target.value)}
            />
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

          <div className="space-y-3 rounded-md border border-border p-3">
            <div>
              <h3 className="text-sm font-medium">Found on your site — check these</h3>
              <p className="text-xs text-muted-foreground">
                Pulled from your site&rsquo;s own CSS, not guaranteed accurate — a wrong swatch is one click to remove.
              </p>
            </div>

            <ColorListEditor
              label="Colors"
              hint="Hex values found in your site's markup and stylesheets."
              items={colors}
              onChange={setColors}
            />
            {visibleAddedColors.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Added from extraction: {visibleAddedColors.join(", ")} — save to keep.
              </p>
            )}

            <BrandListEditor
              label="Fonts"
              hint="Font families found in your site's markup and stylesheets."
              items={fonts}
              onChange={setFonts}
            />
            {visibleAddedFonts.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Added from extraction: {visibleAddedFonts.join(", ")} — save to keep.
              </p>
            )}

            <div>
              <Label>Visual notes</Label>
              <Textarea
                name="visual_notes"
                rows={2}
                value={fields.visual_notes}
                onChange={(e) => set("visual_notes", e.target.value)}
              />
              {proposals.visual_notes !== undefined && (
                <ProposalRow
                  value={proposals.visual_notes}
                  onUse={() => applyProposal("visual_notes")}
                  onKeep={() => keepProposal("visual_notes")}
                />
              )}
            </div>
          </div>

          <input type="hidden" name="proof_points" value={JSON.stringify(proofPoints)} readOnly />
          <input type="hidden" name="standing" value={JSON.stringify(standing)} readOnly />
          <input type="hidden" name="colors" value={JSON.stringify(colors)} readOnly />
          <input type="hidden" name="fonts" value={JSON.stringify(fonts)} readOnly />

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
