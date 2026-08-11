import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { scopeToCategoryKeys } from "@/lib/scope";
import { IdeaCard } from "./idea-card";
import { GenerateImagesButton } from "./generate-images-button";
import { ManualIdeaDialog } from "./manual-idea-dialog";
import { categoryColor } from "@/lib/category-colors";
import type { Category, Idea } from "@/lib/types";

export default async function IdeasPage() {
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  const supabase = await createServerSupabase();

  const { data: catData } = await supabase
    .from("categories").select("*").eq("brand_id", brand.id).eq("active", true).order("key");
  const categories = (catData ?? []) as Category[];

  // Guarded like app/(app)/post/page.tsx:49-54 — an empty .in() list is
  // skipped by convention here rather than relying on unverified PostgREST
  // behavior for an empty in.() filter.
  const { data } = categories.length
    ? await supabase
        .from("ideas").select("*")
        // The brand filter goes in the QUERY, ahead of .limit(200). Filtering in
        // memory after an account-wide limit shares that cap across every brand,
        // so a busy brand can push a quieter one out of its own Ideas page —
        // which renders as an empty state with nothing saying content was dropped.
        .in("category_key", categories.map((c) => c.key))
        .order("created_at", { ascending: false }).limit(200)
    : { data: [] as Idea[] };
  const ideas = scopeToCategoryKeys((data ?? []) as Idea[], categories.map((c) => c.key));

  const brandMissing = !brand.business_name.trim();

  const byCategory = new Map<string, Idea[]>();
  for (const idea of ideas) {
    byCategory.set(idea.category_key, [...(byCategory.get(idea.category_key) ?? []), idea]);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Ideas</h1>
        <ManualIdeaDialog categories={categories} />
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
