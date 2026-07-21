export type IdeaStatus =
  | "pending_review" | "approved" | "rejected"
  | "generating" | "generated" | "posted" | "failed";

export interface Category {
  id: string;
  key: string;
  name: string;
  style_guide: string;
  style_ref_url: string;
  post_caption: string;
  buffer_channel_id: string;
  buffer_account: 1 | 2;
  images_per_carousel: number;
  aspect_ratio: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Idea {
  id: string;
  category_key: string;
  concept: string;
  resolved_prompt: string;
  ai_filter_reason: string;
  approved: boolean;
  status: IdeaStatus;
  batch_id: string;
  created_at: string;
  updated_at: string;
}

export interface Generation {
  id: string;
  idea_id: string;
  kie_task_id: string;
  status: "submitted" | "polling" | "succeeded" | "failed";
  poll_count: number;
  kie_style_url: string;
  full_prompt: string;
  refinement_notes: string;
  image_path: string;
  public_url: string;
  error: string;
  created_at: string;
  updated_at: string;
}

export interface Post {
  id: string;
  category_key: string;
  buffer_update_id: string;
  caption: string;
  status: "created" | "queued" | "failed";
  error: string;
  created_at: string;
  updated_at: string;
}
