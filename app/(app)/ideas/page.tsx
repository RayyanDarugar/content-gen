import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { scopeToCategoryKeys } from "@/lib/scope";
import { IdeaCard } from "./idea-card";
import { GenerateImagesButton } from "./generate-images-button";
import { ManualIdeaDialog } from "./manual-idea-dialog";
import { categoryColor } from "@/lib/category-colors";
import type { Category, CategoryOverlay, Idea, IdeaOverlayFill } from "@/lib/types";

// The fill controls below invoke setOverlayFill/clearOverlayFill, which
// re-composite this idea's affected slides — a fetch, a sharp pass and a
// Cloudinary upload each. Server Action budgets come from the page that calls
// them, not from the "use server" module, so it has to live here.
export const maxDuration = 120;

export default async function IdeasPage() {
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  const supabase = await createServerSupabase();

  // Unfiltered by `active` — this list drives the ideas scope below, and an
  // idea under a category the user just toggled inactive must stay visible
  // (it still needs approving/rejecting), not vanish with no explanation.
  const { data: catData } = await supabase
    .from("categories").select("*").eq("brand_id", brand.id).order("key");
  const categories = (catData ?? []) as Category[];
  // ManualIdeaDialog should only offer categories you can still generate
  // into, so it gets the active-filtered subset instead.
  const activeCategories = categories.filter((c) => c.active);

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

  // Slots for these categories, and the fills the visible ideas already have.
  // Both guarded like every other .in() here — an empty list skips the query.
  const { data: slotData } = categories.length
    ? await supabase
        .from("category_overlays").select("*")
        .in("category_id", categories.map((c) => c.id))
        .eq("is_slot", true).eq("active", true)
        .order("sort_order")
    : { data: [] as CategoryOverlay[] };
  const slots = (slotData ?? []) as CategoryOverlay[];

  const { data: fillData } = ideas.length
    ? await supabase
        .from("idea_overlay_fills").select("*")
        .in("idea_id", ideas.map((i) => i.id))
    : { data: [] as IdeaOverlayFill[] };
  const fills = (fillData ?? []) as IdeaOverlayFill[];

  // An idea knows its category by KEY; a slot knows it by ID.
  const categoryIdByKey = new Map(categories.map((c) => [c.key, c.id]));

  const brandMissing = !brand.business_name.trim();

  const byCategory = new Map<string, Idea[]>();
  for (const idea of ideas) {
    byCategory.set(idea.category_key, [...(byCategory.get(idea.category_key) ?? []), idea]);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Ideas</h1>
        <ManualIdeaDialog categories={activeCategories} />
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
            {group.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                slots={slots.filter((s) => s.category_id === categoryIdByKey.get(idea.category_key))}
                fills={fills.filter((f) => f.idea_id === idea.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
