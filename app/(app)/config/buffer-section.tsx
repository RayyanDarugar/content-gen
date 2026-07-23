"use client";
import { useActionState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { saveBufferToken, disconnectBufferAction } from "./actions";

export function BufferSection({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveBufferToken, undefined);
  const [disconnecting, startDisconnect] = useTransition();

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Buffer</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">Connection</span>
          <Badge variant={connected ? "success" : "outline"}>
            {connected ? "connected" : "not connected"}
          </Badge>
        </div>
        <form action={action} className="space-y-2">
          <div>
            <Label>Buffer personal key</Label>
            <Input
              name="token"
              type="password"
              placeholder={connected ? "•••••••• (paste a new key to replace it)" : "Paste your Buffer personal key"}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Get this from Buffer → Settings → API → Personal Keys.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
            {connected && (
              <Button
                type="button"
                variant="outline"
                disabled={disconnecting}
                onClick={() => startDisconnect(async () => {
                  await disconnectBufferAction();
                  router.refresh();
                })}
              >
                Disconnect
              </Button>
            )}
            {state?.ok && <span className="text-sm text-status-success">Saved.</span>}
            {state?.error && <span className="text-sm text-destructive">{state.error}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
