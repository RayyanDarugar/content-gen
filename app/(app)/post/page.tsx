import { createServerSupabase } from "@/lib/supabase/server";
import { PostComposer } from "./post-composer";
import { Badge } from "@/components/ui/badge";
import type { Postable } from "@/lib/athena/carousel";
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
      .in("status", ["generated", "generating"])
      .order("created_at", { ascending: true }),
    supabase.from("posts").select("*").order("created_at", { ascending: false }).limit(50),
  ]);
  const categories = (catData ?? []) as Category[];
  const ideas = (ideaData ?? []) as IdeaWithGenerations[];
  const posts = (postData ?? []) as Post[];

  // Postable = newest succeeded generation per (idea, slide). An idea can
  // hold several slides (carousel) and a slide can be retried (e.g. a failed
  // anchor resubmit, or a manual regenerate), so dedupe within each slide
  // rather than within the whole idea — otherwise a retried slide would
  // shadow its siblings instead of just its own earlier attempt. The idea no
  // longer needs to have fully reached "generated": a carousel stuck mid-
  // fan-out still offers its succeeded slides here.
  const postablesByCategory = new Map<string, Postable[]>();
  for (const idea of ideas) {
    const slideCount = (idea.slides ?? []).length || 1;
    const newestBySlide = new Map<number, Generation>();
    for (const g of idea.generations) {
      if (g.status !== "succeeded" || !g.public_url) continue;
      const existing = newestBySlide.get(g.slide_index);
      if (!existing || g.created_at > existing.created_at) {
        newestBySlide.set(g.slide_index, g);
      }
    }
    if (newestBySlide.size === 0) continue;
    const list = postablesByCategory.get(idea.category_key) ?? [];
    for (const g of newestBySlide.values()) {
      list.push({
        generation_id: g.id,
        idea_id: idea.id,
        idea_created_at: idea.created_at,
        public_url: g.public_url,
        concept: idea.concept,
        slide_index: g.slide_index,
        slide_count: slideCount,
        post_text: idea.post_text ?? "",
      });
    }
    postablesByCategory.set(idea.category_key, list);
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Post</h1>
      <div className="space-y-6">
        {categories.map((cat) => (
          <PostComposer
            key={cat.key}
            category={cat}
            postables={postablesByCategory.get(cat.key) ?? []}
          />
        ))}
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
