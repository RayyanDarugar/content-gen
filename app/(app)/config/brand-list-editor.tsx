"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_ITEMS } from "@/lib/brand";

export function BrandListEditor({
  label,
  hint,
  items,
  onChange,
}: {
  label: string;
  hint: string;
  items: string[];
  onChange(items: string[]): void;
}) {
  function setItem(index: number, value: string) {
    onChange(items.map((item, i) => (i === index ? value : item)));
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function dropIfEmpty(index: number) {
    if (!items[index]?.trim()) removeItem(index);
  }

  function addItem() {
    if (items.length >= MAX_ITEMS) return;
    onChange([...items, ""]);
  }

  // parseBrandList (lib/brand.ts) silently truncates to MAX_ITEMS on save.
  // Capping additions here — and saying so — means that limit is never hit
  // as a surprise: nothing the user added in this session can vanish on
  // reload without warning.
  const atLimit = items.length >= MAX_ITEMS;

  return (
    <div>
      <Label>{label}</Label>
      <p className="mb-1 text-xs text-muted-foreground">{hint}</p>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input value={item} onChange={(e) => setItem(index, e.target.value)} onBlur={() => dropIfEmpty(index)} />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Remove"
              onClick={() => removeItem(index)}
            >
              ×
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={addItem} disabled={atLimit}>
        + Add
      </Button>
      {atLimit && (
        <p className="mt-1 text-xs text-muted-foreground">Limit of {MAX_ITEMS} reached — remove one to add another.</p>
      )}
    </div>
  );
}
