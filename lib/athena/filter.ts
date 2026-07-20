interface RawIdea { idea_id: string; category: string; concept: string; }
interface Decision { idea_id: string; keep: boolean; reason: string; }

export function applyFilterDecisions(ideas: RawIdea[], decisions: Decision[]) {
  const map = new Map(decisions.map((d) => [d.idea_id, d]));
  return ideas.map((idea) => {
    const d = map.get(idea.idea_id);
    return {
      ...idea,
      ai_keep: d?.keep ?? true,
      ai_filter_reason: d?.reason ?? "no decision returned — defaulting to keep",
    };
  });
}
