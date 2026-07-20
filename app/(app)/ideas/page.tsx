import { createServerSupabase } from "@/lib/supabase/server";
import { IdeaCard } from "./idea-card";
import type { Idea } from "@/lib/types";

export default async function IdeasPage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("ideas").select("*").order("created_at", { ascending: false }).limit(200);
  const ideas = (data ?? []) as Idea[];

  const byCategory = new Map<string, Idea[]>();
  for (const idea of ideas) {
    byCategory.set(idea.category_key, [...(byCategory.get(idea.category_key) ?? []), idea]);
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Ideas</h1>
      {ideas.length === 0 && <p>No ideas yet — go to Generate.</p>}
      {[...byCategory.entries()].map(([key, group]) => (
        <section key={key} className="space-y-3">
          <h2 className="text-lg font-semibold">{key} ({group.length})</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.map((idea) => <IdeaCard key={idea.id} idea={idea} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
