import "server-only";
import { buildCreatePostMutation } from "./carousel";

export interface BufferResult {
  success: boolean;
  postId: string;
  error: string;
  rawBody: string;
}

export async function postToBuffer(
  token: string,
  channelId: string,
  imageUrls: string[],
  caption: string,
): Promise<BufferResult> {
  const body = buildCreatePostMutation(channelId, imageUrls, caption);
  const res = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      // Use the header form verified in Task 1 (default: Bearer).
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const rawBody = await res.text();
  let postId = "";
  let error = "";
  try {
    const json = JSON.parse(rawBody);
    postId = json?.data?.createPost?.post?.id ?? "";
    error = json?.data?.createPost?.message ?? "";
    if (!postId && !error && json?.errors) {
      error = JSON.stringify(json.errors);
    }
  } catch {
    error = `non-JSON response (HTTP ${res.status})`;
  }
  if (!postId && !error) error = `no post id in response (HTTP ${res.status})`;
  return { success: !!postId, postId, error, rawBody };
}
