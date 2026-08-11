"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrainIcon } from "@/components/train-icon";

export function LoginForm({ linkFailed = false }: { linkFailed?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [notice, setNotice] = useState("");
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

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const supabase = createBrowserSupabase();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/update-password`,
    });
    // Deliberately the same message whether or not that email has an account,
    // and the call's error is not surfaced — revealing which addresses are
    // registered is exactly what app/signup/actions.ts declines to do too.
    setNotice("If that email has an account, a reset link is on its way.");
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrainIcon className="h-6 w-6 text-primary" />
          Content Engine
        </CardTitle>
      </CardHeader>
      <CardContent>
        {linkFailed && (
          <p className="mb-3 text-sm text-destructive">
            That link didn&apos;t work — it may have expired. Request a new one.
          </p>
        )}
        {mode === "signin" ? (
          <>
            <form onSubmit={signIn} className="space-y-3">
              <Input type="email" placeholder="you@example.com" value={email}
                onChange={(e) => setEmail(e.target.value)} required />
              <Input type="password" placeholder="Password" value={password}
                onChange={(e) => setPassword(e.target.value)} required />
              <Button type="submit" className="w-full">Sign in</Button>
              {err && <p className="text-sm text-destructive">{err}</p>}
            </form>
            <p className="mt-3 text-sm text-muted-foreground">
              No account? <Link href="/signup" className="underline">Sign up</Link>
            </p>
            <button
              type="button"
              className="mt-1 text-sm underline text-muted-foreground"
              onClick={() => { setMode("reset"); setErr(""); setNotice(""); }}
            >
              Forgot password?
            </button>
          </>
        ) : (
          <>
            <form onSubmit={requestReset} className="space-y-3">
              <Input type="email" placeholder="you@example.com" value={email}
                onChange={(e) => setEmail(e.target.value)} required />
              <Button type="submit" className="w-full">Send reset link</Button>
              {err && <p className="text-sm text-destructive">{err}</p>}
              {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
            </form>
            <button
              type="button"
              className="mt-3 text-sm underline text-muted-foreground"
              onClick={() => { setMode("signin"); setErr(""); setNotice(""); }}
            >
              Back to sign in
            </button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
