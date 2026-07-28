import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { uploadImageToCloudinary } from "@/lib/cloudinary";
import type { Category, RoleRefUrls, Slide } from "@/lib/types";

export const maxDuration = 120;

type Role = Slide["role"];
const ROLES: readonly Role[] = ["hook", "beat", "payoff", "single"];

// Kie result URLs are ephemeral — this endpoint re-hosts a chosen test-run
// image on Cloudinary and cements it as that role's permanent reference
// (spec §10). Any per-entry failure fails the whole request: partial
// promotion would silently mix cemented and uncemented roles.
const MAX_BYTES = 15 * 1024 * 1024;

function isRole(key: string): key is Role {
  return (ROLES as readonly string[]).includes(key);
}

export async function POST(request: NextRequest) {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryId = typeof body?.categoryId === "string" && body.categoryId ? body.categoryId : null;
  const rawRefs = body?.refs;

  if (
    !categoryId ||
    !rawRefs ||
    typeof rawRefs !== "object" ||
    Array.isArray(rawRefs)
  ) {
    return NextResponse.json(
      { error: "expected { categoryId: string, refs: { hook?, beat?, payoff?, single? } }" },
      { status: 400 },
    );
  }

  const entries = Object.entries(rawRefs as Record<string, unknown>);
  const isHttpsUrlString = (v: unknown): v is string => {
    if (typeof v !== "string" || !v) return false;
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  };
  if (!entries.length || !entries.every(([k, v]) => isRole(k) && isHttpsUrlString(v))) {
    return NextResponse.json(
      { error: "refs must have at least one of hook/beat/payoff/single, each an https URL string" },
      { status: 400 },
    );
  }
  const refs = entries as [Role, string][];

  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.from("categories").select("*").eq("id", categoryId).maybeSingle();
    if (!data) return NextResponse.json({ error: "unknown category" }, { status: 404 });
    const category = data as Category;

    const uploaded: RoleRefUrls = {};
    for (const [role, url] of refs) {
      uploaded[role] = await fetchAndUpload(url, role);
    }

    const role_ref_urls: RoleRefUrls = { ...category.role_ref_urls, ...uploaded };
    const { error } = await supabase.from("categories").update({ role_ref_urls }).eq("id", categoryId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ role_ref_urls });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("promote refs failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Fetches one Kie result image and re-uploads it to Cloudinary. Protocol is
// already validated (https-only) by the caller before this runs.
async function fetchAndUpload(url: string, role: Role): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${role}: fetch failed with HTTP ${res.status}`);

  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
  if (!contentType.startsWith("image/")) {
    throw new Error(`${role}: expected an image response, got ${contentType || "unknown content-type"}`);
  }

  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    throw new Error(`${role}: image exceeds 15MB limit`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`${role}: image exceeds 15MB limit`);
  }

  const { url: uploadedUrl } = await uploadImageToCloudinary(buffer, contentType);
  return uploadedUrl;
}
