"use client";
import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { setIdeaDecision } from "./actions";
import type { Idea } from "@/lib/types";

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending_review: "outline", approved: "default", rejected: "destructive",
  generating: "secondary", generated: "default", posted: "secondary", failed: "destructive",
};

export function IdeaCard({ idea }: { idea: Idea }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const reviewable = ["pending_review", "approved", "rejected"].includes(idea.status);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <Badge variant={statusVariant[idea.status] ?? "outline"}>{idea.status}</Badge>
        {reviewable && (
          <div className="flex gap-1">
            <Button size="sm" variant={idea.approved ? "default" : "outline"} disabled={pending}
              onClick={() => startTransition(() => setIdeaDecision(idea.id, "approved"))}>
              ✓
            </Button>
            <Button size="sm" variant={idea.status === "rejected" ? "destructive" : "outline"}
              disabled={pending}
              onClick={() => startTransition(() => setIdeaDecision(idea.id, "rejected"))}>
              ✗
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
