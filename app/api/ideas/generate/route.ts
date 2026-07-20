import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { generateIdeas } from "@/lib/athena/generate-ideas";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== process.env.ALLOWED_EMAIL) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const categoryKey = body?.categoryKey;
  const count = Number(body?.count);
  if (typeof categoryKey !== "string" || !Number.isInteger(count) || count < 1 || count > 20) {
    return NextResponse.json(
      { error: "expected { categoryKey: string, count: 1-20 }" }, { status: 400 });
  }

  try {
    const result = await generateIdeas(categoryKey, count);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("idea generation failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
