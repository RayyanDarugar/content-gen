"use client";
import { useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { setIdeaDecision } from "./actions";
import { SlotStrip } from "./slot-strip";
import type { CategoryOverlay, Idea, IdeaOverlayFill } from "@/lib/types";

const statusVariant: Record<string, "outline" | "pending" | "destructive" | "success" | "queued"> = {
  pending_review: "outline", approved: "pending", rejected: "destructive",
  generating: "pending", generated: "success", posted: "queued", failed: "destructive",
};

export function IdeaCard({
  idea, slots = [], fills = [],
}: {
  idea: Idea;
  slots?: CategoryOverlay[];
  fills?: IdeaOverlayFill[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const reviewable = ["pending_review", "approved", "rejected"].includes(idea.status);
  const slides = idea.slides ?? [];
  // A fill whose image_url is empty counts as unfilled, matching
  // resolveOverlaysForIdea's treatment of an empty image as no fill.
  const filledIds = new Set(fills.filter((f) => f.image_url).map((f) => f.overlay_id));
  const unfilled = slots.filter((s) => !filledIds.has(s.id));

  return (
    <Card className="transition-all hover:-translate-y-0.5 hover:shadow-lg hover:ring-primary/30">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-1.5">
          <Badge variant={statusVariant[idea.status] ?? "outline"}>{idea.status}</Badge>
          {unfilled.length > 0 && (
            <Badge variant="outline" className="border-amber-500/50 text-amber-700">
              {unfilled.length === 1 ? "1 slot unfilled" : `${unfilled.length} slots unfilled`}
            </Badge>
          )}
        </div>
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
        <p className="text-sm whitespace-pre-wrap">{idea.concept}</p>

        <SlotStrip ideaId={idea.id} slots={slots} fills={fills} />

        {/* The point of reviewing an idea is judging the story, not the label.
            Collapsed shows the copy that lands on each panel; expanding adds
            the visual direction. */}
        {slides.length > 0 && (
          <ol className="space-y-1.5 border-l-2 border-border pl-3">
            {slides.map((slide, i) => (
              <li key={i} className="space-y-0.5">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {slide.role}
                  </span>
                  <span className="text-sm">{slide.text || <em>(no text)</em>}</span>
                </div>
                {expanded && slide.visual && (
                  <p className="text-xs text-muted-foreground">{slide.visual}</p>
                )}
              </li>
            ))}
          </ol>
        )}

        {slides.some((s) => s.visual) && (
          <button className="text-xs underline text-muted-foreground"
            onClick={() => setExpanded(!expanded)}>
            {expanded ? "hide visuals" : "show visuals"}
          </button>
        )}

        {idea.post_text?.trim() && (
          <div className="mt-2 rounded-md border bg-muted/40 p-2">
            <button
              type="button"
              className="text-xs font-medium text-muted-foreground"
              onClick={() => setCopyOpen((v) => !v)}
            >
              {copyOpen ? "Hide post copy" : "Show post copy"}
            </button>
            {copyOpen && <p className="mt-1 whitespace-pre-wrap text-sm">{idea.post_text}</p>}
          </div>
        )}

        {idea.ai_filter_reason && (
          <p className="text-xs text-muted-foreground">AI filter: {idea.ai_filter_reason}</p>
        )}
      </CardContent>
    </Card>
  );
}
