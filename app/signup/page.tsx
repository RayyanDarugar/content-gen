"use client";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";
import { signUp } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrainIcon } from "@/components/train-icon";

export default function SignupPage() {
  const router = useRouter();
  const [state, action, pending] = useActionState(signUp, undefined);

  // On success (no error returned and the form was submitted), sign the user in
  // client-side so the session cookie is set, then land them on Config — a
  // fresh account has no keys/brand/categories yet, so Ideas is empty and
  // useless until they set those up first.
  useEffect(() => {
    if (state && !state.error) {
      router.push("/config");
      router.refresh();
    }
  }, [state, router]);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrainIcon className="h-6 w-6 text-primary" />
            Create your account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
            <Input name="email" type="email" placeholder="you@example.com" required />
            <Input name="password" type="password" placeholder="Password (8+ chars)" required />
            <Input name="invite" type="text" placeholder="Invite code" required />
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Creating…" : "Sign up"}
            </Button>
            {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          </form>
          <p className="mt-3 text-sm text-muted-foreground">
            Already have an account? <Link href="/login" className="underline">Sign in</Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
