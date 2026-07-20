import Link from "next/link";
import { Button } from "@/components/ui/button";

const nav = [
  { href: "/ideas", label: "Ideas" },
  { href: "/generate", label: "Generate" },
  { href: "/gallery", label: "Gallery" },
  { href: "/post", label: "Post" },
  { href: "/config", label: "Config" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-48 shrink-0 border-r p-4 flex flex-col gap-1">
        <div className="font-bold mb-4">Athena Content</div>
        {nav.map((n) => (
          <Link key={n.href} href={n.href}
            className="rounded px-3 py-2 text-sm hover:bg-accent">{n.label}</Link>
        ))}
        <form action="/auth/signout" method="post" className="mt-auto">
          <Button variant="ghost" size="sm" type="submit">Sign out</Button>
        </form>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
