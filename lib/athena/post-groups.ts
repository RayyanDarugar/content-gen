export interface PostGroupRow {
  postGroupId: string;
  categoryKey: string;
  createdAt: string;
  scheduledAt: string | null;
  channels: {
    postId: string;
    channelId: string;
    service: string;
    status: string;
    error: string;
    caption: string;
  }[];
  queued: number;
  failed: number;
  label: string;
}

export function groupPosts(
  posts: {
    id: string;
    post_group_id: string;
    category_key: string;
    created_at: string;
    scheduled_at: string | null;
    buffer_channel_id: string;
    buffer_channel_service: string;
    status: string;
    error: string;
    caption: string;
  }[],
): PostGroupRow[] {
  if (posts.length === 0) return [];

  // Group by post_group_id, preserving insertion order
  const groupMap = new Map<
    string,
    (typeof posts)[0][]
  >();

  for (const post of posts) {
    if (!groupMap.has(post.post_group_id)) {
      groupMap.set(post.post_group_id, []);
    }
    groupMap.get(post.post_group_id)!.push(post);
  }

  // Convert to PostGroupRow[], computing stats and sorting
  const groups = Array.from(groupMap.entries()).map(([postGroupId, groupPosts]) => {
    // Take category_key and scheduled_at from the first post
    const first = groupPosts[0];

    // Count statuses
    let queued = 0;
    let failed = 0;
    for (const post of groupPosts) {
      if (post.status === "queued") {
        queued++;
      } else {
        failed++;
      }
    }

    // Build label
    const parts: string[] = [];
    if (queued > 0) parts.push(`${queued} queued`);
    if (failed > 0) parts.push(`${failed} failed`);
    const label = parts.join(" · ");

    // Find the newest created_at in the group
    let newestCreatedAt = first.created_at;
    for (const post of groupPosts) {
      if (post.created_at > newestCreatedAt) {
        newestCreatedAt = post.created_at;
      }
    }

    return {
      postGroupId,
      categoryKey: first.category_key,
      createdAt: newestCreatedAt,
      scheduledAt: first.scheduled_at,
      channels: groupPosts.map((post) => ({
        postId: post.id,
        channelId: post.buffer_channel_id,
        service: post.buffer_channel_service,
        status: post.status,
        error: post.error,
        caption: post.caption,
      })),
      queued,
      failed,
      label,
    };
  });

  // Sort by createdAt descending (newest first)
  groups.sort((a, b) => {
    if (b.createdAt > a.createdAt) return 1;
    if (b.createdAt < a.createdAt) return -1;
    return 0;
  });

  return groups;
}
