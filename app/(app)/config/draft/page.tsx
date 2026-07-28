import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getKeyStatus } from "@/lib/settings/user-secrets";
import { DraftWizard } from "./draft-wizard";
import type { Category } from "@/lib/types";

export default async function DraftPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const user = await requireUser();
  const { category: categoryId } = await searchParams;

  let category: Category | null = null;
  if (categoryId) {
    const supabase = await createServerSupabase();
    const { data } = await supabase
      .from("categories").select("*").eq("id", categoryId).maybeSingle();
    category = (data as Category) ?? null;
  }
  const keys = await getKeyStatus(user.id);
  return <DraftWizard initialCategory={category} keys={keys} />;
}
