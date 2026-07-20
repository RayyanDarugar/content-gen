import { createServerSupabase } from "@/lib/supabase/server";
import { GalleryCard } from "./gallery-card";
import { RealtimeRefresher } from "./realtime-refresher";
import type { Generation, Idea } from "@/lib/types";

export type IdeaWithGenerations = Idea & { generations: Generation[] };

export default async function GalleryPage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("ideas")
    .select("*, generations(*)")
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "generations", ascending: false })
    .limit(200);

  const ideas = ((data ?? []) as IdeaWithGenerations[]).filter(
    (i) => i.generations.length > 0,
  );

  const byCategory = new Map<string, IdeaWithGenerations[]>();
  for (const idea of ideas) {
    byCategory.set(idea.category_key, [...(byCategory.get(idea.category_key) ?? []), idea]);
  }

  return (
    <div className="space-y-8">
      <RealtimeRefresher />
      <h1 className="text-2xl font-bold">Gallery</h1>
      {ideas.length === 0 && (
        <p>No generations yet — approve ideas and hit Generate images on the Ideas board.</p>
      )}
      {[...byCategory.entries()].map(([key, group]) => (
        <section key={key} className="space-y-3">
          <h2 className="text-lg font-semibold">{key} ({group.length})</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {group.map((idea) => <GalleryCard key={idea.id} idea={idea} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
