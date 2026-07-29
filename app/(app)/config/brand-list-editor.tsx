"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    onChange([...items, ""]);
  }

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
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={addItem}>
        + Add
      </Button>
    </div>
  );
}
