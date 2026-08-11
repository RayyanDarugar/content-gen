import { NextResponse, type NextRequest } from "next/server";
import { createAnthropicClient } from "@/lib/anthropic";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/require-user";
import { requireAnthropicKey } from "@/lib/settings/user-secrets";
import { validateCategoryFields, slugify, type CategoryFields } from "@/lib/categories";
import {
  DraftTurnOutput, buildDraftSystemPrompt, toAnthropicMessages,
  normalizeDraft, categoryToDraft, type DraftTurn, type NormalizedDraft,
} from "@/lib/athena/draft-category";
import { loadBrandContext } from "@/lib/athena/brand-context";
import { getActiveBrand } from "@/lib/auth/active-brand";
import type { Category, FormatSuggestion } from "@/lib/types";
import { friendlyLlmError } from "@/lib/llm-errors";
import { writebackPlan, inventedFormatRow } from "@/lib/athena/suggestion-writeback";

export const maxDuration = 120;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
// One draft object + a short chat reply — nowhere near the 16k idea batches.
const DRAFT_MAX_TOKENS = 4000;

// The columns a conversation turn is allowed to write on an existing row.
// Never: key, active, post_caption, buffer_channel_id — and style_ref_url
// only when the user uploaded a new reference this turn.
function draftColumns(draft: NormalizedDraft) {
  return {
    name: draft.name,
    style_guide: draft.style_guide,
    output_format: draft.output_format,
    post_type: draft.post_type,
    role_guides: draft.role_guides,
    caption_guide: draft.caption_guide,
    images_per_carousel: draft.images_per_carousel,
    aspect_ratio: draft.aspect_ratio,
  };
}

function isDraftTurn(t: unknown): t is DraftTurn {
  if (!t || typeof t !== "object") return false;
  const turn = t as DraftTurn;
  return (
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.text === "string" &&
    (turn.imageUrls === undefined ||
      (Array.isArray(turn.imageUrls) && turn.imageUrls.every((u) => typeof u === "string")))
  );
}

export async function draftCategoryTurnForUser(
  userId: string,
  input: {
    turns: DraftTurn[];
    categoryId: string | null;
    styleRefUrl: string | null;
    suggestionId: string | null;
    brandId: string;
  },
): Promise<{ categoryId: string; assistantMessage: string; draft: NormalizedDraft }> {
  const supabase = createAdminSupabase();

  let existing: Category | null = null;
  if (input.categoryId) {
    const { data } = await supabase
      .from("categories").select("*").eq("id", input.categoryId).eq("user_id", userId).maybeSingle();
    if (!data) throw new Error("unknown category");
    existing = data as Category;
  }

  // An existing category owns the truth; a first turn has none, so the
  // caller's brand (session or MCP argument) decides where the new category
  // will land.
  const brandId = existing?.brand_id ?? input.brandId;
  const brand = await loadBrandContext(brandId);

  const anthropic = createAnthropicClient({
    apiKey: await requireAnthropicKey(userId),
    feature: "category_draft",
  });
  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: DRAFT_MAX_TOKENS,
    system: buildDraftSystemPrompt(brand, existing ? categoryToDraft(existing) : undefined),
    messages: toAnthropicMessages(input.turns as DraftTurn[]),
    output_config: { format: zodOutputFormat(DraftTurnOutput) },
  });
  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(`draft turn returned no parseable output (stop_reason: ${response.stop_reason})`);
  }
  const { assistant_message, ...rest } = parsed;
  const draft = normalizeDraft(rest);

  // Full-fields validation with defaults filled in — same validator the
  // manual actions use, so the wizard can never write a row the editor
  // couldn't have.
  const fields: CategoryFields = {
    ...draft,
    style_ref_url: input.styleRefUrl ?? existing?.style_ref_url ?? "",
    post_caption: existing?.post_caption ?? "",
    buffer_channel_id: existing?.buffer_channel_id ?? "",
    buffer_connection_id: existing?.buffer_connection_id ?? "",
    caption_guide: draft.caption_guide,
    buffer_channel_service: existing?.buffer_channel_service ?? "",
    active: existing?.active ?? false,
  };
  validateCategoryFields(fields);

  let id: string;
  if (existing) {
    const patch = input.styleRefUrl
      ? { ...draftColumns(draft), style_ref_url: input.styleRefUrl }
      : draftColumns(draft);
    const { error } = await supabase.from("categories").update(patch).eq("id", existing.id).eq("user_id", userId);
    if (error) throw new Error(error.message);
    id = existing.id;
  } else {
    id = await insertDraft(supabase, userId, draft, input.styleRefUrl ?? "");
    // Insert path only. On an update this would mint a duplicate format on
    // every subsequent turn of the same conversation.
    if (input.suggestionId) await applyWriteback(supabase, userId, input.suggestionId, id);
  }

  return { categoryId: id, assistantMessage: assistant_message, draft };
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const brand = await getActiveBrand(user.id);
  if (!brand) {
    return NextResponse.json({ error: "Set up a brand before drafting a post type." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const turns = body?.turns;
  if (!Array.isArray(turns) || !turns.length || !turns.every(isDraftTurn) ||
      turns[turns.length - 1].role !== "user") {
    return NextResponse.json(
      { error: "expected { turns: DraftTurn[] } ending in a user turn" }, { status: 400 });
  }
  const categoryId = typeof body?.categoryId === "string" && body.categoryId ? body.categoryId : null;
  const styleRefUrl = typeof body?.styleRefUrl === "string" && body.styleRefUrl ? body.styleRefUrl : null;
  const suggestionId = typeof body?.suggestionId === "string" && body.suggestionId ? body.suggestionId : null;

  try {
    const result = await draftCategoryTurnForUser(user.id, {
      turns, categoryId, styleRefUrl, suggestionId, brandId: brand.id,
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("draft turn failed:", message);
    return NextResponse.json({ error: friendlyLlmError(e) }, { status: 500 });
  }
}

// Same insert createCategory does, with active forced false and a bounded
// retry on key collision (23505) so the model picking an existing name on
// turn 1 doesn't dead-end the conversation. key is immutable after this.
async function insertDraft(
  supabase: Awaited<ReturnType<typeof createAdminSupabase>>,
  userId: string,
  draft: NormalizedDraft,
  styleRefUrl: string,
): Promise<string> {
  const base = slugify(draft.name);
  for (const key of [base, `${base}_2`, `${base}_3`, `${base}_4`, `${base}_5`]) {
    const { data, error } = await supabase
      .from("categories")
      .insert({
        user_id: userId,
        key,
        ...draftColumns(draft),
        style_ref_url: styleRefUrl,
        post_caption: "",
        buffer_channel_id: "",
        active: false,
      })
      .select("id")
      .single();
    if (!error && data) return data.id as string;
    if (error && error.code !== "23505") throw new Error(error.message);
  }
  throw new Error("Could not find a free category name — ask for a different name and resend");
}

// Records where a kept suggestion came from, and saves the format itself when
// the model invented one — this is how the library fills without anyone
// curating it.
//
// Never throws. A category that saved correctly is the user's work; a missing
// formats row is a lost analytics record. Failing the request here would
// trade the former for the latter.
async function applyWriteback(
  supabase: Awaited<ReturnType<typeof createAdminSupabase>>,
  userId: string,
  suggestionId: string,
  categoryId: string,
): Promise<void> {
  try {
    // The admin client bypasses RLS, so we must add explicit .eq("user_id", userId)
    // filters to prevent a forged id from another tenant accessing their data.
    const { data, error: lookupError } = await supabase
      .from("format_suggestions")
      .select("format_id, invented_format, category_id")
      .eq("id", suggestionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);

    // Server-side idempotency guard: category_id is stamped on first persist
    // only. If a prior request already got this far — even if its response
    // never reached the client, e.g. a dropped connection — retrying must be
    // a no-op, not a second link/create and a second stamp that orphans the
    // first category. The client-side suggestionId-clearing is defense in
    // depth, not the guarantee.
    const row = data as Pick<FormatSuggestion, "format_id" | "invented_format" | "category_id"> | null;
    if (row?.category_id) return;

    const plan = writebackPlan(row);

    let sourceFormatId: string | null = null;
    if (plan.kind === "link") {
      sourceFormatId = plan.formatId;
    } else if (plan.kind === "create") {
      const { data: created, error } = await supabase
        .from("formats").insert(inventedFormatRow(userId, plan.invented)).select("id").single();
      if (error) throw new Error(error.message);
      sourceFormatId = created.id as string;
    }

    if (sourceFormatId) {
      const { error: categoryUpdateError } = await supabase.from("categories")
        .update({ source_format_id: sourceFormatId }).eq("id", categoryId).eq("user_id", userId);
      if (categoryUpdateError) throw new Error(categoryUpdateError.message);
    }
    const { error: suggestionUpdateError } = await supabase.from("format_suggestions")
      .update({ category_id: categoryId }).eq("id", suggestionId).eq("user_id", userId);
    if (suggestionUpdateError) throw new Error(suggestionUpdateError.message);
  } catch (e) {
    console.error("suggestion writeback failed:", e instanceof Error ? e.message : String(e));
  }
}
