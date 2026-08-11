import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getActiveBrand } from "@/lib/auth/active-brand";
import { OnboardingSteps } from "./onboarding-steps";
import type { Category } from "@/lib/types";

export default async function OnboardingPage() {
  const user = await requireUser();
  const supabase = await createServerSupabase();

  const brand = await getActiveBrand(user.id);

  // brand may legitimately be null: an account with zero brands reaches this
  // page via requireActiveBrand's redirect elsewhere, and this page is the
  // one place that must tolerate that state rather than looping back to it.
  // The sentinel id matches no real brand_id, so a brandless account simply
  // sees an empty category list instead of every account's categories.
  const { data: catData } = await supabase
    .from("categories").select("*")
    .eq("brand_id", brand?.id ?? "00000000-0000-0000-0000-000000000000")
    .eq("active", true).order("key");
  const categories = (catData ?? []) as Category[];

  // ideas has no brand_id column of its own (spec §3.2) — scope through the
  // brand's own category keys, same as app/(app)/ideas/page.tsx, and skip the
  // query on an empty list rather than relying on unverified .in([]) behavior.
  const { count: ideaCount } = categories.length
    ? await supabase
        .from("ideas").select("*", { count: "exact", head: true })
        .in("category_key", categories.map((c) => c.key))
    : { count: 0 };

  const brandDone = Boolean(brand?.business_name?.trim());
  const categoryDone = categories.length > 0;
  const ideasDone = (ideaCount ?? 0) > 0;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Set up your content engine</h1>
        <p className="text-muted-foreground">
          Three quick steps — tell us about your brand, draft a post type, and generate your first ideas.
        </p>
      </div>
      <OnboardingSteps
        brand={brand}
        brandDone={brandDone}
        categoryDone={categoryDone}
        ideasDone={ideasDone}
        firstCategoryKey={categories[0]?.key ?? null}
      />
    </div>
  );
}
