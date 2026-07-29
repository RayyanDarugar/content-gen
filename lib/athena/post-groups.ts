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
  // Legacy/other statuses (e.g. a pre-fan-out "created" row) that are
  // neither queued nor failed — kept separate so they're never mislabeled
  // as failures (Minor, review).
  other: number;
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

    // Count statuses — only an actual "failed" row counts as failed (Minor,
    // review). A legacy/other status (e.g. "created", a row that never
    // progressed) is neither a success nor a failure, so it must not read
    // as one.
    let queued = 0;
    let failed = 0;
    let other = 0;
    for (const post of groupPosts) {
      if (post.status === "queued") {
        queued++;
      } else if (post.status === "failed") {
        failed++;
      } else {
        other++;
      }
    }

    // Build label
    const parts: string[] = [];
    if (queued > 0) parts.push(`${queued} queued`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (other > 0) parts.push(`${other} pending`);
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
      other,
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
