import { createServerSupabase } from "@/lib/supabase/server";
import { PostComposer } from "./post-composer";
import type { Postable } from "@/lib/athena/carousel";
import type { Category, Generation, Idea, Post } from "@/lib/types";

type IdeaWithGenerations = Idea & { generations: Generation[] };

export default async function PostPage() {
  const supabase = await createServerSupabase();
  const [{ data: catData }, { data: ideaData }, { data: postData }] = await Promise.all([
    supabase.from("categories").select("*").eq("active", true).order("key"),
    supabase
      .from("ideas")
      .select("*, generations(*)")
      .eq("status", "generated")
      .order("created_at", { ascending: true }),
    supabase.from("posts").select("*").order("created_at", { ascending: false }).limit(50),
  ]);
  const categories = (catData ?? []) as Category[];
  const ideas = (ideaData ?? []) as IdeaWithGenerations[];
  const posts = (postData ?? []) as Post[];

  // Postable = newest succeeded generation per generated idea.
  const postablesByCategory = new Map<string, Postable[]>();
  for (const idea of ideas) {
    const newest = idea.generations
      .filter((g) => g.status === "succeeded" && g.public_url)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!newest) continue;
    const list = postablesByCategory.get(idea.category_key) ?? [];
    list.push({
      generation_id: newest.id,
      idea_id: idea.id,
      idea_created_at: idea.created_at,
      public_url: newest.public_url,
      concept: idea.concept,
    });
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
                      {p.status === "failed" ? (
                        <span className="text-red-500">failed</span>
                      ) : p.status}
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
