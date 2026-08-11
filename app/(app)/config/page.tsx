import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { requireActiveBrand } from "@/lib/auth/active-brand";
import { getKeyStatus } from "@/lib/settings/user-secrets";
import { listBufferConnections, getBufferChannelsForConnection, type ChannelGroup } from "@/lib/settings/buffer";
import { CategoryManager } from "./category-manager";
import { KeysSection } from "./keys-section";
import { BrandSection } from "./brand-section";
import { ConnectionsSection } from "./connections-section";
import type { Category, CategoryOverlay } from "@/lib/types";

export default async function ConfigPage() {
  const user = await requireUser();
  const brand = await requireActiveBrand(user.id);
  const status = await getKeyStatus(user.id);
  const connections = await listBufferConnections(user.id);
  const groups: ChannelGroup[] = await Promise.all(
    connections.map(async (c) => {
      try {
        return { connectionId: c.id, label: c.label, channels: await getBufferChannelsForConnection(user.id, c.id), error: "" };
      } catch (e) {
        return { connectionId: c.id, label: c.label, channels: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("categories").select("*").eq("brand_id", brand.id).order("key");
  const categoryIds = ((data ?? []) as Category[]).map((c) => c.id);
  const { data: overlayData } = categoryIds.length
    ? await supabase.from("category_overlays").select("*").in("category_id", categoryIds).order("sort_order")
    : { data: [] as CategoryOverlay[] };
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Config</h1>

      {/* Account band — yours, shared by every brand */}
      <section className="space-y-4 rounded-2xl border p-4">
        <h2 className="text-sm font-semibold text-muted-foreground">Account settings</h2>
        <KeysSection status={status} />
        <ConnectionsSection groups={groups} />
        <div className="flex justify-end gap-4">
          <Link href="/config/formats" className="text-sm text-primary underline-offset-4 hover:underline">
            Format library
          </Link>
          <Link href="/onboarding" className="text-sm text-primary underline-offset-4 hover:underline">
            Run setup again
          </Link>
        </div>
      </section>

      {/* Brand band — belongs to whichever brand the switcher has active */}
      <section className="space-y-4 rounded-2xl border border-primary/40 bg-primary/5 p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{brand.business_name}</h2>
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold tracking-wide text-primary">
            BRAND
          </span>
          <Link href="/onboarding?new=1" className="ml-auto text-sm text-primary underline-offset-4 hover:underline">
            Add brand
          </Link>
        </div>
        <BrandSection brand={brand} />
        <CategoryManager
          categories={(data ?? []) as Category[]}
          groups={groups}
          brandDone={Boolean(brand.business_name.trim())}
          hasKieKey={status.kie}
          overlays={(overlayData ?? []) as CategoryOverlay[]}
        />
      </section>
    </div>
  );
}
