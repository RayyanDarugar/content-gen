"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const params = useSearchParams();
  const router = useRouter();

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setErr(error.message);
      return;
    }
    router.push("/ideas");
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader><CardTitle>Athena Content</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={signIn} className="space-y-3">
          <Input type="email" placeholder="you@example.com" value={email}
            onChange={(e) => setEmail(e.target.value)} required />
          <Input type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} required />
          <Button type="submit" className="w-full">Sign in</Button>
          {params.get("error") === "unauthorized" && (
            <p className="text-sm text-red-500">That email is not allowed.</p>
          )}
          {err && <p className="text-sm text-red-500">{err}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
