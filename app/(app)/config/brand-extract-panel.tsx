"use client";
import { useRef, useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { uploadBrandDocument } from "./actions";

export interface BrandDraft {
  business_name: string;
  business_description: string;
  audience: string;
  voice: string;
  avoid: string;
  proof_points: string[];
  standing: string[];
}

type ExtractResponse = (BrandDraft & { warnings: string[] }) | { error: string };

export function BrandExtractPanel({ onDraft }: { onDraft(draft: BrandDraft): void }) {
  const [url, setUrl] = useState("");
  const [docs, setDocs] = useState<{ url: string; name: string }[]>([]);
  const [describe, setDescribe] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setUploading(true);
    setError("");
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await uploadBrandDocument(fd);
      if (res.error) {
        setError(`${file.name}: ${res.error}`);
      } else if (res.url) {
        setDocs((d) => [...d, { url: res.url as string, name: file.name }]);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function removeDoc(index: number) {
    setDocs((d) => d.filter((_, i) => i !== index));
  }

  const empty = !url.trim() && docs.length === 0 && !describe.trim();

  function extract() {
    setError("");
    setWarnings([]);
    startTransition(async () => {
      try {
        const res = await fetch("/api/brand/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: url.trim() || undefined,
            documentUrls: docs.map((d) => d.url),
            turns: describe.trim() ? [{ role: "user", text: describe.trim() }] : [],
          }),
        });
        const data = (await res.json().catch(() => null)) as ExtractResponse | null;
        if (!res.ok || !data || "error" in data) {
          setError((data && "error" in data && data.error) || `Extraction failed (HTTP ${res.status})`);
          return;
        }
        const { warnings: draftWarnings, ...draft } = data;
        setWarnings(draftWarnings);
        onDraft(draft);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">AI-assisted extraction</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>Website</Label>
          <Input placeholder="https://yourcompany.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div>
          <Label>Documents</Label>
          <p className="mb-1 text-xs text-muted-foreground">Pitch decks, one-pagers, PDFs or images.</p>
          <input ref={fileRef} type="file" accept=".pdf,image/*" multiple onChange={onFiles} className="block text-sm" />
          {uploading && <p className="mt-1 text-xs text-muted-foreground">Uploading…</p>}
          {docs.length > 0 && (
            <ul className="mt-2 space-y-1">
              {docs.map((doc, index) => (
                <li key={doc.url} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{doc.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Remove"
                    onClick={() => removeDoc(index)}
                  >
                    ×
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <Label>Describe it</Label>
          <Textarea
            rows={3}
            placeholder="Tell us about the business, in your own words…"
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button type="button" disabled={pending || uploading || empty} onClick={extract}>
            {pending ? "Reading…" : "Read this and draft my brand"}
          </Button>
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>
        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`} className="text-xs text-amber-600 dark:text-amber-400">{warning}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
