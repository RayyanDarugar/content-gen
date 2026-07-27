// Stands in for the cron while it's paused: polls the local route until every
// tracked carousel completes (or fails), then exits.
//
//   npx tsx scripts/watch-poll.ts               # defaults: port 3001, 15 rounds, 45s apart
//   npx tsx scripts/watch-poll.ts --port=3000
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const PORT = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "3001";
const ROUNDS = Number(process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 15);
const EVERY_MS = 45_000;

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function inFlight() {
  const { data } = await db
    .from("ideas").select("id, concept, slides").eq("status", "generating");
  const ideas = (data ?? []).filter((i) => ((i.slides ?? []) as unknown[]).length > 0);
  if (!ideas.length) return { ideas: [], summary: "none" };

  const { data: gens } = await db
    .from("generations").select("idea_id, slide_index, status")
    .in("idea_id", ideas.map((i) => i.id));

  const summary = ideas.map((i) => {
    const rows = (gens ?? []).filter((g) => g.idea_id === i.id);
    const ok = new Set(rows.filter((g) => g.status === "succeeded").map((g) => g.slide_index)).size;
    const bad = rows.filter((g) => g.status === "failed").length;
    const total = ((i.slides ?? []) as unknown[]).length;
    return `${i.concept.slice(0, 28)}… ${ok}/${total}${bad ? ` (${bad} failed)` : ""}`;
  }).join(" | ");

  return { ideas, summary };
}

async function main() {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET not set");

  for (let round = 1; round <= ROUNDS; round++) {
    const res = await fetch(`http://localhost:${PORT}/api/jobs/poll`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await res.text();
    const { ideas, summary } = await inFlight();
    console.log(`[${round}/${ROUNDS}] poll ${res.status} ${body.slice(0, 110)}`);
    console.log(`        generating: ${summary}`);

    if (!ideas.length) { console.log("\nnothing left generating — done"); return; }
    if (round < ROUNDS) await new Promise((r) => setTimeout(r, EVERY_MS));
  }
  console.log("\nround limit reached; re-run if slides are still in flight");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
