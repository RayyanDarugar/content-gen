"use client";
import { useActionState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { saveApiKeys } from "./actions";

export function KeysSection({ status }: { status: { anthropic: boolean; kie: boolean } }) {
  const [state, action, pending] = useActionState(saveApiKeys, undefined);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">API Keys</CardTitle></CardHeader>
      <CardContent>
        <form action={action} className="space-y-3">
          <div>
            <Label className="flex items-center gap-2">
              Anthropic key
              <Badge variant={status.anthropic ? "success" : "outline"}>
                {status.anthropic ? "set" : "not set"}
              </Badge>
            </Label>
            <Input name="anthropic" type="password" placeholder="sk-ant-… (leave blank to keep)" />
          </div>
          <div>
            <Label className="flex items-center gap-2">
              Kie.ai key
              <Badge variant={status.kie ? "success" : "outline"}>
                {status.kie ? "set" : "not set"}
              </Badge>
            </Label>
            <Input name="kie" type="password" placeholder="Kie API key (leave blank to keep)" />
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save keys"}</Button>
            {state?.ok && <span className="text-sm text-status-success">Saved.</span>}
            {state?.error && <span className="text-sm text-destructive">{state.error}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
