// READ-ONLY verification helper for the structured-carousels branch.
// Shows the state the UI can't: slide arrays, per-slide generation status,
// and which anchor each slide was generated against.
//
//   npx tsx scripts/inspect-carousels.ts          # 10 most recent ideas
//   npx tsx scripts/inspect-carousels.ts 25       # more
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const LIMIT = Number(process.argv[2] ?? 10);
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ICON: Record<string, string> = {
  succeeded: "OK  ",
  failed: "FAIL",
  submitted: "... ",
  polling: "... ",
};

async function main() {
  console.log(`project: ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`);

  const { data: ideas, error } = await db
    .from("ideas")
    .select("id, category_key, concept, status, slides, created_at")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw new Error(error.message);

  const ids = (ideas ?? []).map((i) => i.id);
  const { data: gens } = await db
    .from("generations")
    .select("id, idea_id, slide_index, anchor_generation_id, status, public_url, error, created_at")
    .in("idea_id", ids)
    .order("created_at");

  const byIdea = new Map<string, typeof gens>();
  for (const g of gens ?? []) {
    byIdea.set(g.idea_id, [...(byIdea.get(g.idea_id) ?? []), g]);
  }

  let empties = 0;

  for (const idea of ideas ?? []) {
    const slides = (idea.slides ?? []) as { role: string; text: string }[];
    if (!slides.length) empties++;

    console.log("─".repeat(78));
    console.log(`${idea.category_key}  [${idea.status}]  ${idea.concept.slice(0, 52)}`);
    console.log(`${slides.length} slide(s): ${slides.map((s) => s.role).join(" → ") || "(NONE — legacy or unbackfilled)"}`);

    const rows = byIdea.get(idea.id) ?? [];
    if (!rows.length) {
      console.log("   no generations yet");
      continue;
    }

    // Anchors are slide 0; everything else names the anchor it was built against.
    const anchors = rows.filter((r) => r.slide_index === 0);
    const newestAnchor = anchors
      .filter((r) => r.status === "succeeded")
      .reduce<(typeof rows)[number] | null>(
        (best, r) => (!best || r.created_at > best.created_at ? r : best), null);

    for (const r of rows) {
      const isAnchor = r.slide_index === 0;
      const current =
        isAnchor
          ? newestAnchor && r.id === newestAnchor.id ? " ← current anchor" : ""
          : newestAnchor && r.anchor_generation_id === newestAnchor.id ? "" : " ← STALE ANCHOR";
      const note = r.status === "failed" ? `  ${r.error.slice(0, 44)}` : "";
      console.log(
        `   slide ${r.slide_index}  ${ICON[r.status] ?? r.status}` +
          `${isAnchor ? "  [anchor]" : ""}${current}${note}`,
      );
    }

    // Anchor-scoped, matching what the poll route requires to complete an
    // idea. Counting succeeded slides across every anchor reports a carousel
    // as done when its CURRENT anchor still has failures — a false MISMATCH.
    const succeededAnchors = rows.filter((r) => r.slide_index === 0 && r.status === "succeeded");
    const cur = succeededAnchors.length
      ? succeededAnchors.reduce((n, r) => (r.created_at > n.created_at ? r : n))
      : null;
    const succeeded = new Set(
      rows.filter((r) =>
        r.status === "succeeded" &&
        (r.slide_index === 0
          ? cur && r.id === cur.id
          : !cur || !r.anchor_generation_id || r.anchor_generation_id === cur.id),
      ).map((r) => r.slide_index));
    const complete = slides.length > 0 && [...Array(slides.length).keys()].every((i) => succeeded.has(i));
    const expected = complete ? "generated" : "generating";
    if (slides.length && idea.status !== "posted" && idea.status !== expected &&
        ["generating", "generated"].includes(idea.status)) {
      console.log(`   *** MISMATCH: ${succeeded.size}/${slides.length} slides done but status is "${idea.status}" ***`);
    }
  }

  console.log("─".repeat(78));
  const { count: emptyTotal } = await db
    .from("ideas").select("*", { count: "exact", head: true }).eq("slides", "[]");
  console.log(`ideas with slides = [] across the whole table: ${emptyTotal ?? 0}`);
  if (emptyTotal) {
    console.log("  (rows production wrote after migration 0008 but before this branch deploys —");
    console.log("   submitGenerations falls back to a single slide from `concept`, so they still work)");
  }
  if (empties) console.log(`of the ${LIMIT} shown, ${empties} have no slides`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
