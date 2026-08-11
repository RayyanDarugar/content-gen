import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { scopeToCategoryKeys } from "@/lib/scope";
import { GalleryCard } from "./gallery-card";
import { RealtimeRefresher } from "./realtime-refresher";
import { categoryColor } from "@/lib/category-colors";
import type { CategoryOverlay, Generation, Idea } from "@/lib/types";

export type IdeaWithGenerations = Idea & { generations: Generation[] };

export default async function GalleryPage() {
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  const supabase = await createServerSupabase();

  const { data: catData } = await supabase
    .from("categories").select("id, key").eq("brand_id", brand.id);
  const cats = (catData ?? []) as { id: string; key: string }[];
  const keys = cats.map((c) => c.key);

  // Guarded like app/(app)/post/page.tsx:49-54 — an empty .in() list is
  // skipped by convention here rather than relying on unverified PostgREST
  // behavior for an empty in.() filter.
  const { data } = keys.length
    ? await supabase
        .from("ideas")
        .select("*, generations(*)")
        // Same reason as the Ideas page: the brand filter must precede .limit(200),
        // or the cap is shared across brands and a busy brand hides a quiet one.
        .in("category_key", keys)
        .order("created_at", { ascending: false })
        .order("created_at", { referencedTable: "generations", ascending: false })
        .limit(200)
    : { data: [] as IdeaWithGenerations[] };

  const ideas = scopeToCategoryKeys((data ?? []) as IdeaWithGenerations[], keys)
    .filter((i) => i.generations.length > 0);

  // Same guarded-empty-.in() convention as the ideas query above. Only
  // active slots count (an inactive slot cannot composite, so badging it
  // would be noise) — mirrors resolveOverlaysForIdea (lib/athena/overlay-slots.ts).
  const { data: slotData } = cats.length
    ? await supabase
        .from("category_overlays").select("*")
        .in("category_id", cats.map((c) => c.id))
        .eq("is_slot", true).eq("active", true)
    : { data: [] as CategoryOverlay[] };
  const slots = (slotData ?? []) as CategoryOverlay[];

  const { data: fillData } = ideas.length
    ? await supabase
        .from("idea_overlay_fills").select("overlay_id, idea_id, image_url")
        .in("idea_id", ideas.map((i) => i.id))
    : { data: [] as { overlay_id: string; idea_id: string; image_url: string }[] };
  const fills = (fillData ?? []) as { overlay_id: string; idea_id: string; image_url: string }[];

  const categoryIdByKey = new Map(cats.map((c) => [c.key, c.id]));
  const unfilledByIdea = new Map<string, number>();
  for (const idea of ideas) {
    const ideaSlots = slots.filter((s) => s.category_id === categoryIdByKey.get(idea.category_key));
    // A fill with an empty image_url counts as unfilled — same rule
    // resolveOverlaysForIdea applies — so the badge and compositing agree
    // on what shipped.
    const filled = new Set(
      fills.filter((f) => f.idea_id === idea.id && f.image_url).map((f) => f.overlay_id),
    );
    unfilledByIdea.set(idea.id, ideaSlots.filter((s) => !filled.has(s.id)).length);
  }

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
            {group.map((idea) => (
              <GalleryCard key={idea.id} idea={idea} unfilledSlots={unfilledByIdea.get(idea.id) ?? 0} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
