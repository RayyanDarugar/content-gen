import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { scopeToCategoryKeys } from "@/lib/scope";
import { GalleryCard } from "./gallery-card";
import { RealtimeRefresher } from "./realtime-refresher";
import { categoryColor } from "@/lib/category-colors";
import type { Generation, Idea } from "@/lib/types";

export type IdeaWithGenerations = Idea & { generations: Generation[] };

export default async function GalleryPage() {
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  const supabase = await createServerSupabase();

  const { data: catData } = await supabase
    .from("categories").select("key").eq("brand_id", brand.id);
  const keys = ((catData ?? []) as { key: string }[]).map((c) => c.key);

  const { data } = await supabase
    .from("ideas")
    .select("*, generations(*)")
    // Same reason as the Ideas page: the brand filter must precede .limit(200),
    // or the cap is shared across brands and a busy brand hides a quiet one.
    .in("category_key", keys)
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "generations", ascending: false })
    .limit(200);

  const ideas = scopeToCategoryKeys((data ?? []) as IdeaWithGenerations[], keys)
    .filter((i) => i.generations.length > 0);

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
          <h2 className="flex items-center gap-2 text-lg">
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: categoryColor(key) }}
            />
            {key} ({group.length})
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {group.map((idea) => <GalleryCard key={idea.id} idea={idea} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
