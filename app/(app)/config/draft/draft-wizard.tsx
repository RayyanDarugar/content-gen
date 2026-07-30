"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uploadStyleRefImage } from "../actions";
import { categoryToDraft, type DraftTurn, type NormalizedDraft } from "@/lib/athena/draft-category";
import { suggestionToTurns, type SuggestResponse } from "@/lib/athena/suggest-category";
import type { Category } from "@/lib/types";
import { PreviewPane } from "./preview-pane";

interface Props {
  initialCategory: Category | null;
  keys: { anthropic: boolean; kie: boolean };
  suggest?: boolean;
}

export function DraftWizard({ initialCategory, keys, suggest = false }: Props) {
  const router = useRouter();
  const [turns, setTurns] = useState<DraftTurn[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(initialCategory?.id ?? null);

  // Start-screen input slots
  const [description, setDescription] = useState("");
  const [formatUrls, setFormatUrls] = useState<string[]>([]);   // "show it" screenshots
  const [brandRefUrl, setBrandRefUrl] = useState(initialCategory?.style_ref_url ?? "");
  // A brand ref uploaded but not yet sent with a turn
  const [pendingStyleRef, setPendingStyleRef] = useState<string | null>(null);
  const [uploading, setUploading] = useState<"format" | "brand" | null>(null);

  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  // Suggest mode. The suggestion is held client-side and persists nothing
  // until the user engages — otherwise every re-roll would litter Config with
  // abandoned categories.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [excludeConcepts, setExcludeConcepts] = useState<string[]>([]);
  const [excludeFormatIds, setExcludeFormatIds] = useState<string[]>([]);

  const lastDraft: NormalizedDraft | null =
    [...turns].reverse().find((t) => t.role === "assistant")?.draft ??
    (initialCategory ? categoryToDraft(initialCategory) : null);

  async function upload(kind: "brand", file: File) {
    setUploading(kind);
    setError("");
    const fd = new FormData();
    fd.append("file", file);
    const res = await uploadStyleRefImage(fd);
    setUploading(null);
    if (res.error || !res.url) { setError(`Upload failed: ${res.error ?? "no url"}`); return; }
    setBrandRefUrl(res.url);
    setPendingStyleRef(res.url);
  }

  async function uploadFormatFiles(files: FileList) {
    setUploading("format");
    setError("");
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await uploadStyleRefImage(fd);
      if (res.error || !res.url) {
        setError(`Upload failed: ${res.error ?? "no url"}`);
        break;
      }
      setFormatUrls((prev) => [...prev, res.url!]);
    }
    setUploading(null);
  }

  async function fetchSuggestion() {
    setSuggesting(true);
    setError("");
    try {
      const res = await fetch("/api/categories/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludeConcepts, excludeFormatIds }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const suggestion = json as SuggestResponse;
      // Replaces the held suggestion rather than appending to it: a re-roll
      // is a different proposal, not the next turn of a conversation.
      setTurns(suggestionToTurns(suggestion));
      setSuggestionId(suggestion.suggestionId);
      setExcludeConcepts((prev) => [...prev, suggestion.sample.concept]);
      if (suggestion.formatId) {
        setExcludeFormatIds((prev) => [...prev, suggestion.formatId!]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  }

  // Fires once. The ref guards against React's development double-invoke,
  // which would otherwise bill two LLM calls and log two impressions.
  const suggestedOnce = useRef(false);
  useEffect(() => {
    if (!suggest || !keys.anthropic || suggestedOnce.current) return;
    suggestedOnce.current = true;
    void fetchSuggestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggest, keys.anthropic]);

  async function send(text: string, imageUrls?: string[]) {
    const userTurn: DraftTurn = { role: "user", text, imageUrls };
    const nextTurns = [...turns, userTurn];
    setTurns(nextTurns);
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/categories/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turns: nextTurns,
          categoryId: categoryId ?? undefined,
          styleRefUrl: pendingStyleRef ?? undefined,
          suggestionId: suggestionId ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCategoryId(json.categoryId);
      setPendingStyleRef(null);
      setSuggestionId(null);
      setTurns([...nextTurns, { role: "assistant", text: json.assistantMessage, draft: json.draft }]);
    } catch (e) {
      // Spec §7: a failed turn leaves conversation state untouched so the
      // user can just resend — roll back the optimistic user turn and
      // restore the composer.
      setTurns(turns);
      setComposer(text);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  function start() {
    if (!description.trim() && formatUrls.length === 0) return;
    void send(description.trim(), formatUrls.length ? formatUrls : undefined);
  }

  if (!keys.anthropic) {
    return (
      <Card>
        <CardContent className="py-6 text-sm">
          Add your Anthropic API key in <Link className="underline" href="/config">Config</Link> to
          draft with AI.
        </CardContent>
      </Card>
    );
  }

  const started = turns.length > 0;

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {initialCategory ? `Revise "${initialCategory.name}" with AI` : "Draft a post type with AI"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {suggesting && (
              <p className="text-sm text-muted-foreground">Reading your brand and drafting a suggestion…</p>
            )}

            {!started && !suggesting && suggest && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Couldn&apos;t draft a suggestion.
                </p>
                <div className="flex gap-2">
                  <Button onClick={() => void fetchSuggestion()}>Try again</Button>
                  <Button variant="outline" render={<Link href="/config/draft" />}>
                    Build my own instead
                  </Button>
                </div>
              </div>
            )}

            {!started && !suggesting && !suggest && (
              <div className="space-y-3">
                <div>
                  <Label>Describe it</Label>
                  <Textarea
                    rows={4}
                    placeholder="e.g. Myth-busting carousels: open with a common SAT myth, debunk it over two panels, end with the real insight."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Or show it — screenshots of a post whose format you like (optional)</Label>
                  <p className="text-xs text-muted-foreground">
                    Only their structure and copy pattern are used — never their colors or art style.
                    For a carousel, upload one screenshot per slide, in order.
                  </p>
                  <input type="file" accept="image/*" multiple className="block text-sm"
                    onChange={(e) => e.target.files && e.target.files.length > 0 && uploadFormatFiles(e.target.files)} />
                  {uploading === "format" && <p className="text-xs text-muted-foreground">Uploading…</p>}
                  {formatUrls.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {formatUrls.map((u) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={u} src={u} alt="format example" className="h-32 rounded border object-cover" />
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <Label>Brand visual reference (optional)</Label>
                  <p className="text-xs text-muted-foreground">
                    {brandRefUrl
                      ? "This image controls the visual look of everything generated."
                      : "No reference set — previews and generation will look generic until one is added."}
                  </p>
                  <input type="file" accept="image/*" className="block text-sm"
                    onChange={(e) => e.target.files?.[0] && upload("brand", e.target.files[0])} />
                  {uploading === "brand" && <p className="text-xs text-muted-foreground">Uploading…</p>}
                  {brandRefUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={brandRefUrl} alt="brand reference" className="mt-2 h-32 rounded border object-cover" />
                  )}
                </div>
                <Button onClick={start} disabled={sending || (!description.trim() && formatUrls.length === 0)}>
                  {sending ? "Drafting…" : "Start drafting"}
                </Button>
              </div>
            )}

            {started && (
              <div className="space-y-3">
                <div className="max-h-[50vh] space-y-3 overflow-y-auto">
                  {turns.map((t, i) => (
                    <div key={i}
                      className={t.role === "user" ? "ml-8 rounded-lg bg-muted p-3 text-sm" : "mr-8 rounded-lg border p-3 text-sm"}>
                      {t.imageUrls?.map((u) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={u} src={u} alt="" className="mb-2 h-24 rounded border object-cover" />
                      ))}
                      <p className="whitespace-pre-wrap">{t.text}</p>
                    </div>
                  ))}
                  {sending && <p className="text-sm text-muted-foreground">Thinking…</p>}
                </div>
                {suggestionId && (
                  <Button variant="outline" size="sm" disabled={suggesting || sending}
                    onClick={() => void fetchSuggestion()}>
                    Suggest a different one
                  </Button>
                )}
                <div className="flex gap-2">
                  <Textarea rows={2} value={composer} placeholder="Refine the draft…"
                    onChange={(e) => setComposer(e.target.value)} />
                  <Button
                    disabled={sending || !composer.trim()}
                    onClick={() => { const text = composer; setComposer(""); void send(text); }}>
                    Send
                  </Button>
                </div>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>

        {categoryId && lastDraft && (
          <PreviewPane
            categoryId={categoryId}
            postType={lastDraft.post_type}
            hasStyleRef={!!brandRefUrl && !pendingStyleRef}
            hasKieKey={keys.kie}
          />
        )}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Live draft</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!lastDraft && <p className="text-muted-foreground">The draft appears here as you talk.</p>}
            {lastDraft && (
              <>
                <DraftField label="Name" value={lastDraft.name} />
                <DraftField label="Post type"
                  value={lastDraft.post_type === "narrative"
                    ? `Narrative — ${lastDraft.images_per_carousel} slides, one story`
                    : "Independent — each image stands alone"} />
                <DraftField label="Style guide" value={lastDraft.style_guide} />
                <DraftField label="Output format" value={lastDraft.output_format} />
                {Object.entries(lastDraft.role_guides).map(([role, guide]) => (
                  <DraftField key={role} label={`Treatment: ${role}`} value={guide ?? ""} />
                ))}
                <DraftField label="Copy guide" value={lastDraft.caption_guide} />
                <DraftField label="Aspect ratio" value={lastDraft.aspect_ratio} />
              </>
            )}
            {categoryId && (
              <div className="pt-2">
                <p className="mb-2 text-xs text-muted-foreground">
                  Saved automatically as an inactive category after every reply.
                </p>
                <Button variant="outline" size="sm" onClick={() => router.push("/config")}>
                  Open in editor
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DraftField({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap">{value}</p>
    </div>
  );
}
