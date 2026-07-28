"use client";
import { useActionState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { addBufferConnectionAction, removeBufferConnectionAction } from "./actions";
import type { ChannelGroup } from "@/lib/settings/buffer";

export function ConnectionsSection({ groups }: { groups: ChannelGroup[] }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(addBufferConnectionAction, undefined);
  const [removing, startRemove] = useTransition();

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Buffer connections</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No connections yet — add one Buffer account below. You can add several.
          </p>
        )}
        {groups.map((g) => (
          <div key={g.connectionId} className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{g.label}</span>
              {g.error
                ? <Badge variant="destructive">key invalid or expired</Badge>
                : <Badge variant="success">{g.channels.length} channels</Badge>}
            </div>
            <Button
              variant="outline" size="sm" disabled={removing}
              onClick={() => {
                if (!confirm(`Remove "${g.label}"? Categories using its channels will need a new pick.`)) return;
                startRemove(async () => {
                  await removeBufferConnectionAction(g.connectionId);
                  router.refresh();
                });
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <form action={action} className="space-y-2 border-t pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Connection name</Label>
              <Input name="label" placeholder="e.g. Athena account" />
            </div>
            <div>
              <Label>Buffer personal key</Label>
              <Input name="token" type="password" placeholder="Paste the personal key" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Get this from Buffer → Settings → API → Personal Keys, logged into the account you&apos;re adding.
          </p>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add connection"}</Button>
            {state?.ok && <span className="text-sm text-status-success">Added.</span>}
            {state?.error && <span className="text-sm text-destructive">{state.error}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
