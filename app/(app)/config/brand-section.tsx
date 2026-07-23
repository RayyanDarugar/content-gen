"use client";
import { useActionState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { saveBrandProfile } from "./actions";
import type { BrandProfile } from "@/lib/types";

export function BrandSection({ brand }: { brand: BrandProfile | null }) {
  const [state, action, pending] = useActionState(saveBrandProfile, undefined);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Brand</CardTitle></CardHeader>
      <CardContent>
        <form action={action} className="space-y-3">
          <div><Label>Business name</Label>
            <Input name="business_name" defaultValue={brand?.business_name ?? ""} /></div>
          <div><Label>What the business is</Label>
            <Textarea name="business_description" rows={3} defaultValue={brand?.business_description ?? ""} /></div>
          <div><Label>Target audience</Label>
            <Input name="audience" defaultValue={brand?.audience ?? ""} /></div>
          <div><Label>Voice / tone</Label>
            <Input name="voice" defaultValue={brand?.voice ?? ""} /></div>
          <div><Label>Never lead with / avoid</Label>
            <Textarea name="avoid" rows={2} defaultValue={brand?.avoid ?? ""} /></div>
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
