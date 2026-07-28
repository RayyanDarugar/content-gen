import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { getKeyStatus } from "@/lib/settings/user-secrets";
import { listBufferConnections, getBufferChannelsForConnection, type ChannelGroup } from "@/lib/settings/buffer";
import { CategoryManager } from "./category-manager";
import { KeysSection } from "./keys-section";
import { BrandSection } from "./brand-section";
import { ConnectionsSection } from "./connections-section";
import type { BrandProfile, Category } from "@/lib/types";

export default async function ConfigPage() {
  const user = await requireUser();
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
  const { data } = await supabase.from("categories").select("*").order("key");
  const { data: brandRow } = await supabase
    .from("brand_profiles").select("*").maybeSingle();
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Config</h1>
      <KeysSection status={status} />
      <BrandSection brand={(brandRow as BrandProfile) ?? null} />
      <ConnectionsSection groups={groups} />
      <CategoryManager categories={(data ?? []) as Category[]} groups={groups} />
    </div>
  );
}
