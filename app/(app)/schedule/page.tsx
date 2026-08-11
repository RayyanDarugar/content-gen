import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { bucketSchedule, type ScheduleRow } from "@/lib/schedule";
import { brandColor } from "@/lib/category-colors";
import { Badge } from "@/components/ui/badge";
import type { Post } from "@/lib/types";

// Treatment C: a coloured left rail carries the brand, so a row's owner
// registers as a shape before any text is read, while the list keeps its true
// chronological order. The badge repeats the brand in words — colour alone is
// never the only channel carrying the information.
function ScheduleItem({ row, withTime }: { row: ScheduleRow; withTime?: boolean }) {
  const { post, brandName, brandId } = row;
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-l-[3px] p-3"
      style={{ borderLeftColor: brandColor(brandId) }}
    >
      {withTime && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {new Date(post.scheduled_at!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </span>
      )}
      <span className="truncate text-sm">{post.caption || post.category_key}</span>
      <Badge variant="outline" className="ml-auto shrink-0">{brandName}</Badge>
    </div>
  );
}

// The one page that ignores the brand switcher (spec §9): its whole purpose
// is answering "is anything going out for Kana this week?" without switching.
export default async function SchedulePage() {
  const user = await requireUser();
  const supabase = await createServerSupabase();

  const { data: catData } = await supabase
    .from("categories").select("key, brand_id");
  const { data: brandData } = await supabase
    .from("brand_profiles").select("id, business_name").eq("user_id", user.id);

  const brandById = new Map(
    ((brandData ?? []) as { id: string; business_name: string }[]).map((b) => [b.id, b.business_name]),
  );
  // category_key -> the owning brand, resolved once so each row can be
  // coloured and labelled without a per-row lookup.
  const brandByKey = new Map(
    ((catData ?? []) as { key: string; brand_id: string }[]).map((c) => [
      c.key,
      { id: c.brand_id, name: brandById.get(c.brand_id) ?? "—" },
    ]),
  );

  const { data: postData } = await supabase
    .from("posts").select("*").neq("status", "failed")
    .order("scheduled_at", { ascending: true }).limit(200);

  const rows: ScheduleRow[] = ((postData ?? []) as Post[]).map((post) => {
    const brand = brandByKey.get(post.category_key);
    return { post, brandName: brand?.name ?? "—", brandId: brand?.id ?? "" };
  });
  const { scheduled, queued } = bucketSchedule(rows);

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Schedule</h1>
        <p className="text-sm text-muted-foreground">Every brand, in one place.</p>
      </div>

      {scheduled.length === 0 && queued.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing scheduled yet.</p>
      )}

      {scheduled.map((day) => (
        <section key={day.date} className="space-y-2">
          <h2 className="text-sm font-semibold">
            {new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, {
              weekday: "long", month: "short", day: "numeric",
            })}
          </h2>
          {day.rows.map((row) => <ScheduleItem key={row.post.id} row={row} withTime />)}
        </section>
      ))}

      {queued.length > 0 && (
        <section className="space-y-2 rounded-xl border border-dashed p-3">
          <h2 className="text-sm font-semibold">In Buffer&rsquo;s queue</h2>
          <p className="text-xs text-muted-foreground">
            Buffer picks the time for these — no fixed slot is stored here.
          </p>
          {queued.map((row) => <ScheduleItem key={row.post.id} row={row} />)}
        </section>
      )}
    </div>
  );
}
