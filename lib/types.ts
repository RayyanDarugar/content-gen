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

export type FormatOrigin = "observed" | "invented";

// A reusable post structure. Landing early from project 2's object model:
// the suggestion lane reads it, and a future scraper writes into it.
export interface Format {
  id: string;
  user_id: string;
  name: string;
  structure: string;
  why_it_works: string;
  source_example: string;
  brand_fit: string;
  screenshot_url: string;
  origin: FormatOrigin;
  shared: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// What the model conceived when it invented a structure instead of drawing
// on the library. Stored on the suggestion row at suggest time so writeback
// keeps what it actually conceived, rather than reconstructing a lossy
// version from the category's columns after the fact.
export interface InventedFormat {
  name: string;
  structure: string;
  why_it_works: string;
  brand_fit: string;
}

export interface FormatSuggestion {
  id: string;
  user_id: string;
  format_id: string | null;
  concept: string;
  invented_format: InventedFormat | null;
  category_id: string | null;
  created_at: string;
}

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
  source_format_id: string | null;
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

export type StyleRefJobStatus = "submitted" | "polling" | "succeeded" | "failed";

export interface StyleRefJob {
  id: string;
  user_id: string;
  category_id: string;
  kie_task_id: string;
  status: StyleRefJobStatus;
  poll_count: number;
  style_ref_url: string;
  error: string;
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
  proof_points: string[];
  standing: string[];
  colors: string[];
  fonts: string[];
  visual_notes: string;
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
