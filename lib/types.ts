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

export type OverlayCorner =
  | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";

export type OverlayShape = "none" | "circle" | "rounded";
export type OverlayTint = "none" | "grayscale" | "color";

// An exact asset composited onto finished slides (spec §2). Configured per
// category and targeted by role, the same way role_guides is.
export interface CategoryOverlay {
  id: string;
  user_id: string;
  category_id: string;
  name: string;
  image_url: string;
  // true → the image comes from each idea's fill, and image_url is empty.
  is_slot: boolean;
  roles: Slide["role"][];
  corner: OverlayCorner;
  margin_pct: number;
  size_pct: number;
  opacity: number;
  shape: OverlayShape;
  // Percentage of the layer's own width.
  border_width_pct: number;
  border_color: string;
  tint: OverlayTint;
  tint_color: string;
  shadow: boolean;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// One idea's image for one slot. Joins on overlay_id, which is why the slot
// needs no key of its own.
export interface IdeaOverlayFill {
  id: string;
  user_id: string;
  idea_id: string;
  overlay_id: string;
  image_url: string;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  user_id: string;
  brand_id: string;
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
  // The published artifact — public_url with overlays composited on. Empty
  // when the category has no overlays. Read via publishedImageUrl(), never
  // directly, and never by a generation path.
  composited_url: string;
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
  id: string;
  user_id: string;
  is_default: boolean;
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

export type AutopilotPeriod = "day" | "week";

// One row per category (unique on category_id): "this category publishes
// posts_per_period times per period, in this timezone."
export interface AutopilotWorkflow {
  id: string;
  user_id: string;
  category_id: string;
  posts_per_period: number;
  period: AutopilotPeriod;
  timezone: string;
  max_attempts_per_period: number;
  auto_pause_after_failed_periods: number;
  consecutive_failed_periods: number;
  last_settled_period: string | null;
  // When the sweep last examined this workflow. The sweep orders by it (nulls
  // first) so a fixed cap rotates through every workflow instead of pinning
  // the same oldest N forever.
  last_ticked_at: string | null;
  active: boolean;
  paused_reason: string;
  created_at: string;
  updated_at: string;
}

// `publishing` is the claim state: a tick moves the run into it with a
// conditional update BEFORE calling Buffer, so a second tick that read the
// same run finds the update affecting no rows and declines to post again.
// Nothing else may transition a run out of `posting`.
export type AutopilotRunState =
  | "sourcing" | "awaiting_images" | "posting" | "publishing" | "succeeded" | "failed";

// "" only ever appears on a run still in `sourcing` — the tier is recorded
// the moment one is chosen.
export type AutopilotSource =
  | "" | "retry_images" | "ready_images" | "approved_idea" | "generated";

export interface AutopilotRunStep {
  at: string;
  step: string;
  detail: string;
}

export interface AutopilotRun {
  id: string;
  user_id: string;
  workflow_id: string;
  category_key: string;
  period_start: string;
  attempt_no: number;
  state: AutopilotRunState;
  source: AutopilotSource;
  idea_id: string | null;
  post_group_id: string | null;
  // When the run entered awaiting_images — the anchor for the image-stall
  // deadline. Null until it gets there, which is why readers fall back to
  // created_at.
  awaiting_images_since: string | null;
  // True when the run was found abandoned in `publishing` with no posts rows
  // to prove whether Buffer received the carousel. Its idea is excluded from
  // autopilot sourcing from then on.
  idea_quarantined: boolean;
  error: string;
  steps: AutopilotRunStep[];
  created_at: string;
  updated_at: string;
}
