import { requireUser } from "@/lib/auth/require-user";
import { UpdatePasswordForm } from "./form";

export default async function UpdatePasswordPage() {
  // The recovery session minted by /auth/callback is what authorises this.
  await requireUser();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <UpdatePasswordForm />
    </main>
  );
}
