"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";

export function RealtimeRefresher() {
  const router = useRouter();
  useEffect(() => {
    const supabase = createBrowserSupabase();
    const channel = supabase
      .channel("generations-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "generations" },
        () => router.refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [router]);
  return null;
}
