"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrainIcon } from "@/components/train-icon";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
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
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrainIcon className="h-6 w-6 text-primary" />
          Content Engine
        </CardTitle>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <LoginForm />
    </main>
  );
}
