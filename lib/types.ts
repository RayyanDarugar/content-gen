export type IdeaStatus =
  | "pending_review" | "approved" | "rejected"
  | "generating" | "generated" | "posted" | "failed";

export type PostType = "independent" | "narrative";

// What differs per panel type. style_guide holds what is shared across every
// panel; these hold the treatment belonging to one role only.
export type RoleGuides = Partial<Record<Slide["role"], string>>;

// Per-role cemented reference images (spec §10): a promoted role ref
// replaces the brand style ref for that role. Same shape as RoleGuides,
// but values are durable Cloudinary URLs instead of prose.
export type RoleRefUrls = Partial<Record<Slide["role"], string>>;

export interface Slide {
  role: "hook" | "beat" | "payoff" | "single";
  text: string;   // the words that appear on the panel
  visual: string; // scene, camera angle, subject pose
}

export interface BufferConnection {
  id: string;
  user_id: string;
  label: string;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  user_id: string;
  key: string;
  name: string;
  style_guide: string;
  output_format: string;
  post_type: PostType;
  role_guides: RoleGuides;
  role_ref_urls: RoleRefUrls;
  style_ref_url: string;
  post_caption: string;
  buffer_channel_id: string;
  buffer_connection_id: string | null;
  caption_guide: string;
  buffer_channel_service: string;
  images_per_carousel: number;
  aspect_ratio: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Idea {
  id: string;
  user_id: string;
  category_key: string;
  concept: string;
  resolved_prompt: string;
  ai_filter_reason: string;
  approved: boolean;
  status: IdeaStatus;
  batch_id: string;
  slides: Slide[];
  post_text: string;
  created_at: string;
  updated_at: string;
}

export interface Generation {
  id: string;
  user_id: string;
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
  slide_index: number;
  anchor_generation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Post {
  id: string;
  user_id: string;
  category_key: string;
  buffer_update_id: string;
  post_group_id: string;
  buffer_channel_id: string;
  scheduled_at: string | null;
  adapted_from_caption: string;
  buffer_channel_service: string;
  caption: string;
  status: "created" | "queued" | "failed";
  error: string;
  idea_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrandProfile {
  user_id: string;
  business_name: string;
  business_description: string;
  audience: string;
  voice: string;
  avoid: string;
  created_at: string;
  updated_at: string;
}

export interface BufferChannel {
  id: string;
  name: string;
  displayName: string;
  service: string;
  avatar: string;
  isQueuePaused: boolean;
}
