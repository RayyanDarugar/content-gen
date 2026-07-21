"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lightbulb, Sparkles, Images, Send, Settings } from "lucide-react";

const nav = [
  { href: "/ideas", label: "Ideas", icon: Lightbulb },
  { href: "/generate", label: "Generate", icon: Sparkles },
  { href: "/gallery", label: "Gallery", icon: Images },
  { href: "/post", label: "Post", icon: Send },
  { href: "/config", label: "Config", icon: Settings },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {nav.map((n) => {
        const active = pathname === n.href || pathname?.startsWith(`${n.href}/`);
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={n.href}
            className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-all ${
              active
                ? "bg-primary/15 text-primary font-semibold"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            }`}
          >
            <Icon className="size-4" />
            {n.label}
          </Link>
        );
      })}
    </>
  );
}
