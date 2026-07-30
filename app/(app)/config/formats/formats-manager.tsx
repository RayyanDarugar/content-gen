"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { saveFormat, deleteFormat, uploadStyleRefImage } from "../actions";
import type { Format } from "@/lib/types";

interface Draft {
  name: string;
  structure: string;
  why_it_works: string;
  source_example: string;
  brand_fit: string;
  screenshot_url: string;
}

export function FormatsManager({
  own, shared, hasAnthropicKey,
}: {
  own: Format[];
  shared: Format[];
  hasAnthropicKey: boolean;
}) {
  const [capture, setCapture] = useState<Draft | null>(null);
  const [screenshotUrls, setScreenshotUrls] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"upload" | "draft" | null>(null);
  const [error, setError] = useState("");

  async function uploadFiles(files: FileList) {
    setBusy("upload");
    setError("");
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await uploadStyleRefImage(fd);
      if (res.error || !res.url) { setError(`Upload failed: ${res.error ?? "no url"}`); break; }
      setScreenshotUrls((prev) => [...prev, res.url!]);
    }
    setBusy(null);
  }

  async function draftFromCapture() {
    setBusy("draft");
    setError("");
    try {
      const res = await fetch("/api/formats/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ screenshotUrls, note }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCapture({ ...json.draft, screenshot_url: screenshotUrls[0] ?? "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Format library</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Post structures worth reusing. Suggestions prefer these over inventing something new.
          Formats saved automatically from suggestions you kept are marked{" "}
          <span className="font-medium">invented</span>.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Add from a screenshot</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {!hasAnthropicKey ? (
            <p className="text-sm text-muted-foreground">
              Add your Anthropic API key in Config to catalogue a format from a screenshot.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Only the structure and copy pattern are recorded — never the example&apos;s colors or art style.
                For a carousel, upload one screenshot per slide, in order.
              </p>
              <input type="file" accept="image/*" multiple className="block text-sm"
                onChange={(e) => e.target.files?.length && uploadFiles(e.target.files)} />
              {busy === "upload" && <p className="text-xs text-muted-foreground">Uploading…</p>}
              {screenshotUrls.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {screenshotUrls.map((u) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={u} src={u} alt="" className="h-24 rounded border object-cover" />
                  ))}
                </div>
              )}
              <div>
                <Label>Anything to add (optional)</Label>
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. a16z's 'startups that need to exist' posts" />
              </div>
              <Button disabled={busy !== null || (!screenshotUrls.length && !note.trim())}
                onClick={() => void draftFromCapture()}>
                {busy === "draft" ? "Reading it…" : "Catalogue this format"}
              </Button>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {capture && (
        <FormatForm
          draft={capture}
          title="Review before saving"
          onDone={() => { setCapture(null); setScreenshotUrls([]); setNote(""); }}
        />
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-medium">Your formats</h2>
        {own.length === 0 && (
          <p className="text-sm text-muted-foreground">
            None yet. Formats appear here as you catalogue them, and automatically when you keep a suggestion.
          </p>
        )}
        {own.map((f) => (
          <FormatForm key={f.id} format={f} draft={toDraft(f)} title={f.name} />
        ))}
      </div>

      {shared.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Shared library</h2>
          <p className="text-xs text-muted-foreground">
            Available to every account and read-only here — these are edited directly in Supabase.
          </p>
          {shared.map((f) => (
            <Card key={f.id}>
              <CardHeader><CardTitle className="text-base">{f.name}</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="whitespace-pre-wrap">{f.structure}</p>
                {f.why_it_works && (
                  <p className="text-muted-foreground">{f.why_it_works}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function toDraft(f: Format): Draft {
  return {
    name: f.name, structure: f.structure, why_it_works: f.why_it_works,
    source_example: f.source_example, brand_fit: f.brand_fit,
    screenshot_url: f.screenshot_url,
  };
}

// Every field round-trips, including screenshot_url as a hidden input.
// saveFormat writes every column in its payload, so a field the form omits
// is written back as an empty string on the next save — the same bug class
// proof_points/standing hit on the brand form.
function FormatForm({
  format, draft, title, onDone,
}: {
  format?: Format;
  draft: Draft;
  title: string;
  onDone?: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {format && <Badge variant="outline">{format.origin}</Badge>}
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          action={async (fd: FormData) => {
            const res = await saveFormat(fd);
            setError(res.error ?? "");
            if (!res.error) onDone?.();
          }}
        >
          <input type="hidden" name="id" value={format?.id ?? ""} />
          <input type="hidden" name="screenshot_url" value={draft.screenshot_url} />
          <div>
            <Label>Name</Label>
            <Input name="name" defaultValue={draft.name} />
          </div>
          <div>
            <Label>Structure</Label>
            <Textarea name="structure" rows={3} defaultValue={draft.structure} />
          </div>
          <div>
            <Label>Why it works</Label>
            <Textarea name="why_it_works" rows={2} defaultValue={draft.why_it_works} />
          </div>
          <div>
            <Label>Source example</Label>
            <Input name="source_example" defaultValue={draft.source_example} />
          </div>
          <div>
            <Label>Fits brands that</Label>
            <Textarea name="brand_fit" rows={2} defaultValue={draft.brand_fit} />
          </div>
          <div className="flex items-center gap-2">
            <Switch name="active" defaultChecked={format?.active ?? true} />
            <Label>Available to suggestions</Label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm">Save</Button>
            {format && (
              <Button type="button" variant="outline" size="sm"
                onClick={async () => {
                  const res = await deleteFormat(format.id);
                  setError(res.error ?? "");
                }}>
                Delete
              </Button>
            )}
            {onDone && (
              <Button type="button" variant="outline" size="sm" onClick={onDone}>Discard</Button>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
