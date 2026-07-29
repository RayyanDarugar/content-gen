import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { buildQueueRows } from "@/lib/athena/queue";
import { postedSlideIndexesByIdea, type PostedSlideJoinRow } from "@/lib/athena/carousel";
import { categoryColor } from "@/lib/category-colors";
import { Badge } from "@/components/ui/badge";
import type { Category, Generation, Idea, Post } from "@/lib/types";

const statusVariant: Record<string, "outline" | "queued" | "destructive"> = {
  created: "outline", queued: "queued", failed: "destructive",
};

type IdeaWithGenerations = Idea & { generations: Generation[] };

export default async function PostPage() {
  const supabase = await createServerSupabase();
  const [{ data: catData }, { data: ideaData }, { data: postData }] = await Promise.all([
    supabase.from("categories").select("*").eq("active", true).order("key"),
    supabase
      .from("ideas")
      .select("*, generations(*)")
      .in("status", ["generated", "generating", "approved"])
      .order("created_at", { ascending: true }),
    supabase.from("posts").select("*").order("created_at", { ascending: false }).limit(50),
  ]);
  const categories = (catData ?? []) as Category[];
  const categoryByKey = new Map(categories.map((c) => [c.key, c]));
  const ideas = (ideaData ?? []) as IdeaWithGenerations[];
  const posts = (postData ?? []) as Post[];

  const urlById = new Map<string, string>();
  for (const idea of ideas) {
    for (const g of idea.generations) {
      if (g.status === "succeeded" && g.public_url) urlById.set(g.id, g.public_url);
    }
  }

  // Finding 3: cross-post completeness. A non-failed post that carried one
  // of an idea's slides counts that slide as "posted" for every idea in the
  // queue, not just the one currently open in the composer.
  //
  // Resolved through post_images -> generations, not posts.idea_id: a
  // freeform post spanning several ideas leaves idea_id: null on its own
  // post row, so keying off it would drop that post's slides from every
  // idea's posted count even though they did go out on Buffer.
  const allGenerationIds = ideas.flatMap((idea) => idea.generations.map((g) => g.id));
  const { data: postImageRows } = allGenerationIds.length
    ? await supabase
        .from("post_images")
        .select("generation_id, post:posts(status, buffer_channel_id)")
        .in("generation_id", allGenerationIds)
    : { data: [] as { generation_id: string; post: { status: string; buffer_channel_id: string } | null }[] };
  const slideByGenId = new Map<string, { idea_id: string; slide_index: number }>();
  for (const idea of ideas) {
    for (const g of idea.generations) slideByGenId.set(g.id, { idea_id: idea.id, slide_index: g.slide_index });
  }
  const postedByIdea = postedSlideIndexesByIdea(
    ((postImageRows ?? []) as { generation_id: string; post: { status: string; buffer_channel_id: string } | null }[])
      .map((row): PostedSlideJoinRow | null => {
        const slide = slideByGenId.get(row.generation_id);
        return slide && row.post
          ? {
              post_status: row.post.status,
              idea_id: slide.idea_id,
              slide_index: slide.slide_index,
              buffer_channel_id: row.post.buffer_channel_id,
            }
          : null;
      })
      .filter((row): row is PostedSlideJoinRow => row !== null),
  );
  const ideasWithPosted = ideas.map((idea) => ({
    ...idea,
    posted_slide_indexes: Array.from(postedByIdea.get(idea.id) ?? []),
  }));
  const rows = buildQueueRows(ideasWithPosted, urlById);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Post</h1>
      <div className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing ready to post yet — generate some ideas first.
          </p>
        ) : (
          rows.map((row) => {
            const category = categoryByKey.get(row.categoryKey);
            const ready = row.readyCount === row.slideCount;
            const partiallyPosted = row.postedCount > 0;
            return (
              <Link
                key={row.ideaId}
                href={`/post/${row.ideaId}`}
                className="flex items-center gap-4 rounded-2xl bg-card p-3 ring-1 ring-foreground/10 transition-all hover:-translate-y-0.5 hover:shadow-lg hover:ring-primary/30"
              >
                {row.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={row.thumbnailUrl}
                    alt={row.concept.slice(0, 60)}
                    className="h-16 w-16 shrink-0 rounded-xl border object-cover"
                  />
                ) : (
                  <div className="h-16 w-16 shrink-0 rounded-xl border bg-muted" />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge style={{ backgroundColor: categoryColor(row.categoryKey), color: "black" }}>
                      {category?.name ?? row.categoryKey}
                    </Badge>
                  </div>
                  <p className="truncate text-sm font-medium">{row.concept}</p>
                  {row.postText && (
                    <p className="truncate text-xs text-muted-foreground">{row.postText}</p>
                  )}
                </div>
                {partiallyPosted ? (
                  // Finding 3: a partially-posted idea never shows a green
                  // "N/N ready" — that reads as "safe to post everything",
                  // which would republish what already went out.
                  <Badge variant="pending" className="shrink-0">
                    {row.postedCount} posted · {row.readyCount} ready
                  </Badge>
                ) : (
                  <Badge variant={ready ? "success" : "pending"} className="shrink-0">
                    {row.readyCount}/{row.slideCount} ready
                  </Badge>
                )}
              </Link>
            );
          })
        )}
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">History</h2>
        {posts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No posts yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Category</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Buffer ID</th>
                  <th className="py-2">Caption / Error</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id} className="border-b align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {new Date(p.created_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">{p.category_key}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={statusVariant[p.status] ?? "outline"}>{p.status}</Badge>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{p.buffer_update_id || "—"}</td>
                    <td className="py-2 max-w-md truncate" title={p.error || p.caption}>
                      {p.status === "failed" ? p.error : p.caption}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
