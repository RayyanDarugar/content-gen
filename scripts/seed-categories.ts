import { config } from "dotenv";
config({ path: ".env.local" });
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

// Ported verbatim from n8n Workflow C "Select Posts" node.
const CHANNEL_MAP: Record<string, { channelId: string; account: 1 | 2; name: string }> = {
  SAT_MYTH:        { channelId: "6a5517eb80cc80cdcaac2ddf", account: 1, name: "athenalearns" },
  BRAIN_TEASER:    { channelId: "6a551bc880cc80cdcaac4e2d", account: 1, name: "athenastudy" },
  COMIC:           { channelId: "6a5518d580cc80cdcaac30f5", account: 1, name: "athenastudies_" },
  NOTES_APP:       { channelId: "6a552a2280cc80cdcaac9e06", account: 2, name: "athena.study" },
  BEAGLE_EXPLAINS: { channelId: "6a555a1e80cc80cdcaad980f", account: 2, name: "athena_study" },
};
const IMAGES_PER_CATEGORY: Record<string, number> = {
  SAT_MYTH: 5, BRAIN_TEASER: 5, COMIC: 5, NOTES_APP: 1, BEAGLE_EXPLAINS: 5,
};

async function main() {
  const wb = XLSX.readFile("n8n-files/Athena Content Pipeline.xlsx");
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets["Config"]);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  for (const row of rows) {
    const key = row.category?.trim();
    if (!key || !CHANNEL_MAP[key]) continue;
    const { error } = await supabase.from("categories").upsert(
      {
        key,
        name: key.replace(/_/g, " ").toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        style_guide: row.style_guide ?? "",
        style_ref_url: row.style_ref_url ?? "",
        post_caption: row.post_caption ?? "",
        buffer_channel_id: CHANNEL_MAP[key].channelId,
        buffer_account: CHANNEL_MAP[key].account,
        images_per_carousel: IMAGES_PER_CATEGORY[key] ?? 5,
        aspect_ratio: "4:5",
        active: true,
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(`${key}: ${error.message}`);
    console.log(`upserted ${key}`);
  }

  const { count } = await supabase
    .from("categories").select("*", { count: "exact", head: true });
  console.log(`done — ${count} categories in table`);
}

main().catch((e) => { console.error(e); process.exit(1); });
