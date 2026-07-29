import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { IdeaCard } from "./idea-card";
import { GenerateImagesButton } from "./generate-images-button";
import { ManualIdeaDialog } from "./manual-idea-dialog";
import { categoryColor } from "@/lib/category-colors";
import type { BrandProfile, Category, Idea } from "@/lib/types";

export default async function IdeasPage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("ideas").select("*").order("created_at", { ascending: false }).limit(200);
  const ideas = (data ?? []) as Idea[];

  const { data: catData } = await supabase
    .from("categories").select("*").eq("active", true).order("key");

  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").maybeSingle();
  const brand = (brandRow as BrandProfile) ?? null;
  const brandMissing = !brand?.business_name?.trim();

  const byCategory = new Map<string, Idea[]>();
  for (const idea of ideas) {
    byCategory.set(idea.category_key, [...(byCategory.get(idea.category_key) ?? []), idea]);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Ideas</h1>
        <ManualIdeaDialog categories={(catData ?? []) as Category[]} />
      </div>
      {brandMissing && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
          <div>
            <p className="font-semibold">Set up your brand</p>
            <p className="text-sm text-muted-foreground">
              The generator works from what you tell it about your business.
            </p>
          </div>
          <Link
            href="/onboarding"
            className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            Set up your brand
          </Link>
        </div>
      )}
      {ideas.length === 0 && <p>No ideas yet — go to Generate.</p>}
      {[...byCategory.entries()].map(([key, group]) => (
        <section key={key} className="space-y-3">
          <div className="flex items-center gap-4">
            <h2 className="flex items-center gap-2 text-lg">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: categoryColor(key) }}
              />
              {key} ({group.length})
            </h2>
            {group.some((i) => i.status === "approved") && (
              <GenerateImagesButton
                ideaIds={group.filter((i) => i.status === "approved").map((i) => i.id)}
              />
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.map((idea) => <IdeaCard key={idea.id} idea={idea} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
