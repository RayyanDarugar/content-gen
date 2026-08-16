"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { saveWorkflows } from "./actions";
import { defaultWorkflowSettings } from "./defaults";

// Setting up five categories in one click instead of five. Only categories
// with no workflow yet are sent — an existing workflow, on or off, is left
// exactly as its owner set it, so this button can never quietly reset a rate
// or un-pause something that was paused on purpose.
export function TurnOnAll({ categoryIds }: { categoryIds: string[] }) {
  const [pending, start] = useTransition();

  if (!categoryIds.length) return null;

  function turnOn() {
    start(async () => {
      try {
        const settings = defaultWorkflowSettings();
        await saveWorkflows(categoryIds.map((categoryId) => ({ categoryId, settings })));
        toast.success(
          categoryIds.length === 1
            ? "Autopilot on for 1 category"
            : `Autopilot on for ${categoryIds.length} categories`,
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save");
      }
    });
  }

  return (
    <Button size="sm" variant="outline" onClick={turnOn} disabled={pending}>
      Turn on for every category
    </Button>
  );
}
