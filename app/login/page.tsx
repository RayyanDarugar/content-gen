"use client";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const params = useSearchParams();

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
    });
    if (error) setErr(error.message);
    else setSent(true);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader><CardTitle>Athena Content</CardTitle></CardHeader>
      <CardContent>
        {sent ? (
          <p>Check your email for the sign-in link.</p>
        ) : (
          <form onSubmit={sendLink} className="space-y-3">
            <Input type="email" placeholder="you@example.com" value={email}
              onChange={(e) => setEmail(e.target.value)} required />
            <Button type="submit" className="w-full">Send magic link</Button>
            {params.get("error") === "unauthorized" && (
              <p className="text-sm text-red-500">That email is not allowed.</p>
            )}
            {err && <p className="text-sm text-red-500">{err}</p>}
          </form>
        )}
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
