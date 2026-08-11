"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setActiveBrand } from "./brand-actions";
import type { BrandProfile } from "@/lib/types";

export function BrandSwitcher({ brands, activeId }: { brands: BrandProfile[]; activeId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const active = brands.find((b) => b.id === activeId);

  // A single-brand account has nothing to switch between — showing a
  // disabled dropdown would be noise on the one screen every user sees.
  if (brands.length < 2) {
    return (
      <div className="px-1 pb-3 text-xs font-medium text-muted-foreground truncate">
        {active?.business_name}
      </div>
    );
  }

  function choose(id: string) {
    startTransition(async () => {
      await setActiveBrand(id);
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        className="mb-3 flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm hover:bg-sidebar-accent disabled:opacity-60"
      >
        <span className="truncate font-medium">{active?.business_name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {brands.map((b) => (
          <DropdownMenuItem key={b.id} onClick={() => choose(b.id)} className="gap-2">
            <Check className={`size-3.5 ${b.id === activeId ? "opacity-100" : "opacity-0"}`} />
            <span className="truncate">{b.business_name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
