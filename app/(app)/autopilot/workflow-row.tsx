"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { saveWorkflow, setWorkflowActive } from "./actions";
import { defaultWorkflowSettings } from "./defaults";
import type { WorkflowStatus } from "@/lib/autopilot/status";

const TONE_VARIANT: Record<WorkflowStatus["tone"], "default" | "secondary" | "outline" | "destructive"> = {
  on: "outline", done: "default", working: "secondary", paused: "destructive", off: "outline",
};

export interface RowProps {
  categoryId: string;
  categoryName: string;
  workflowId: string | null;
  active: boolean;
  postsPerPeriod: number;
  period: "day" | "week";
  timezone: string;
  status: WorkflowStatus;
}

export function WorkflowRow(props: RowProps) {
  const [pending, start] = useTransition();

  function toggle() {
    start(async () => {
      try {
        if (!props.workflowId) {
          await saveWorkflow(props.categoryId, defaultWorkflowSettings());
          toast.success(`Autopilot on for ${props.categoryName}`);
          return;
        }
        await setWorkflowActive(props.workflowId, !props.active);
        toast.success(props.active ? "Turned off" : "Turned on");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save");
      }
    });
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border p-3">
      <span className="truncate text-sm font-medium">{props.categoryName}</span>
      <span className="text-xs text-muted-foreground">
        {props.workflowId
          ? `${props.postsPerPeriod}× per ${props.period} · ${props.timezone}`
          : "not set up"}
      </span>
      <Badge variant={TONE_VARIANT[props.status.tone]} className="ml-auto shrink-0">
        {props.status.label}
      </Badge>
      <Button size="sm" variant="outline" onClick={toggle} disabled={pending}>
        {props.workflowId && props.active ? "Turn off" : "Turn on"}
      </Button>
    </div>
  );
}
