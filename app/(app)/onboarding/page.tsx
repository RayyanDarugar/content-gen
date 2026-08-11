import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getActiveBrand } from "@/lib/auth/active-brand";
import { OnboardingSteps } from "./onboarding-steps";
import type { Category } from "@/lib/types";

export default async function OnboardingPage() {
  const user = await requireUser();
  const supabase = await createServerSupabase();

  const brand = await getActiveBrand(user.id);

  const { data: catData } = await supabase
    .from("categories").select("*").eq("active", true).order("key");
  const categories = (catData ?? []) as Category[];

  const { count: ideaCount } = await supabase
    .from("ideas").select("*", { count: "exact", head: true });

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
