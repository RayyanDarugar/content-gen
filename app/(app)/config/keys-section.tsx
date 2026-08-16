"use client";
import { useActionState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { saveApiKeys } from "./actions";

export function KeysSection({
  status,
  onSaved,
}: {
  status: { anthropic: boolean; kie: boolean };
  /**
   * Fired on a successful save. `saveApiKeys` revalidates both /config and
   * /onboarding, but a caller that mounts this section inside a client wizard
   * (the onboarding checklist) still needs its own signal to re-render with
   * the new key status — same contract as BrandSection's `onSaved`.
   */
  onSaved?(): void;
}) {
  const [state, action, pending] = useActionState(saveApiKeys, undefined);

  // Mirrors BrandSection's onSaved plumbing, and for the same two reasons:
  // the callback is kept in a ref so an inline arrow function from the parent
  // can't retrigger this effect on every render, and `firedForRef` keys off
  // the transition to a NEW successful state rather than "ok is currently
  // true" — which stays true across re-renders until the next submit. Either
  // omission turns a parent that calls router.refresh() into a refresh loop.
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
            <p className="mt-1 text-xs text-muted-foreground">
              Writes everything — brand analysis, post types, ideas, captions. Get one at{" "}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline-offset-4 hover:underline"
              >
                console.anthropic.com
              </a>
              .
            </p>
          </div>
          <div>
            <Label className="flex items-center gap-2">
              Kie.ai key
              <Badge variant={status.kie ? "success" : "outline"}>
                {status.kie ? "set" : "not set"}
              </Badge>
            </Label>
            <Input name="kie" type="password" placeholder="Kie API key (leave blank to keep)" />
            <p className="mt-1 text-xs text-muted-foreground">
              Needed only for image generation — you can add it later.
            </p>
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
