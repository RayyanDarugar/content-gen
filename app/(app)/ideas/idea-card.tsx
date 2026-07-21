"use client";
import { useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { setIdeaDecision } from "./actions";
import type { Idea } from "@/lib/types";

const statusVariant: Record<string, "outline" | "pending" | "destructive" | "success" | "queued"> = {
  pending_review: "outline", approved: "pending", rejected: "destructive",
  generating: "pending", generated: "success", posted: "queued", failed: "destructive",
};

export function IdeaCard({ idea }: { idea: Idea }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const reviewable = ["pending_review", "approved", "rejected"].includes(idea.status);

  return (
    <Card className="transition-all hover:-translate-y-0.5 hover:shadow-lg hover:ring-primary/30">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <Badge variant={statusVariant[idea.status] ?? "outline"}>{idea.status}</Badge>
        {reviewable && (
          <div className="flex gap-1.5">
            <Button
              size="icon-sm"
              className="rounded-full"
              variant={idea.approved ? "default" : "outline"}
              disabled={pending}
              onClick={() => startTransition(() => setIdeaDecision(idea.id, "approved"))}
            >
              <Check className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              className="rounded-full"
              variant={idea.status === "rejected" ? "destructive" : "outline"}
              disabled={pending}
              onClick={() => startTransition(() => setIdeaDecision(idea.id, "rejected"))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <p className={`text-sm whitespace-pre-wrap ${expanded ? "" : "line-clamp-4"}`}>
          {idea.concept}
        </p>
        <button className="text-xs underline text-muted-foreground"
          onClick={() => setExpanded(!expanded)}>
          {expanded ? "collapse" : "expand"}
        </button>
        {idea.ai_filter_reason && (
          <p className="text-xs text-muted-foreground">AI filter: {idea.ai_filter_reason}</p>
        )}
      </CardContent>
    </Card>
  );
}
