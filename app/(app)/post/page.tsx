import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { buildQueueRows } from "@/lib/athena/queue";
import { postedSlideIndexesByIdea, type PostedSlideJoinRow } from "@/lib/athena/carousel";
import { groupPosts } from "@/lib/athena/post-groups";
import { publishedImageUrl } from "@/lib/athena/published-image";
import { ServiceIcon } from "@/app/(app)/post/[ideaId]/channel-chips";
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
      if (g.status === "succeeded" && publishedImageUrl(g)) urlById.set(g.id, publishedImageUrl(g));
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
  const postGroups = groupPosts(posts);

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
        {postGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No posts yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Category</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Channels</th>
                  <th className="py-2">Caption / Error</th>
                </tr>
              </thead>
              <tbody>
                {postGroups.map((group) => {
                  const category = categoryByKey.get(group.categoryKey);
                  // Minor (review): the group's own status badge must never
                  // derive from an arbitrary channel[0] — a group summarized
                  // "2 queued · 1 failed" rendered success-green whenever
                  // the FIRST channel happened to be queued. Any failed
                  // channel makes the whole group's badge read as a
                  // failure; otherwise "queued" if anything queued.
                  const groupVariant: "destructive" | "queued" | "outline" =
                    group.failed > 0 ? "destructive" : group.queued > 0 ? "queued" : "outline";
                  return (
                    <tr key={group.postGroupId} className="border-b align-top">
                      <td className="py-2 pr-4 whitespace-nowrap">
                        <div className="space-y-1">
                          <div>{new Date(group.createdAt).toLocaleString()}</div>
                          {group.scheduledAt && (
                            <div className="text-xs text-muted-foreground">
                              scheduled: {new Date(group.scheduledAt).toLocaleString()}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        <Badge style={{ backgroundColor: categoryColor(group.categoryKey), color: "black" }}>
                          {category?.name ?? group.categoryKey}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant={groupVariant}>
                          {group.label}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4">
                        {group.channels.length === 1 ? (
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <ServiceIcon service={group.channels[0]!.service} className="size-3.5" />
                            <span>{group.channels[0]!.channelId}</span>
                          </div>
                        ) : (
                          <details className="cursor-pointer">
                            <summary className="text-xs font-medium">{group.channels.length} channels</summary>
                            <div className="mt-2 space-y-2 text-xs">
                              {group.channels.map((channel, idx) => (
                                <div key={idx} className="space-y-1 border-l border-muted pl-2">
                                  <div className="flex items-center gap-1.5 font-medium">
                                    <ServiceIcon service={channel.service} className="size-3.5" />
                                    <span>{channel.channelId}</span>
                                    <Badge variant={statusVariant[channel.status] ?? "outline"} className="text-xs">
                                      {channel.status}
                                    </Badge>
                                  </div>
                                  {channel.status === "failed" && channel.error && (
                                    <div className="text-destructive" title={channel.error}>
                                      Error: {channel.error}
                                    </div>
                                  )}
                                  <div className="max-w-xs truncate text-muted-foreground" title={channel.caption}>
                                    {channel.caption}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </td>
                      <td className="py-2 max-w-md truncate" title={group.channels[0]?.error || group.channels[0]?.caption}>
                        {group.channels[0]?.status === "failed" ? group.channels[0]?.error : group.channels[0]?.caption}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
