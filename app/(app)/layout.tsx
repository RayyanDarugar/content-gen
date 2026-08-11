import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TrainIcon } from "@/components/train-icon";
import { NavLinks } from "./nav-links";
import { BrandSwitcher } from "./brand-switcher";
import { requireUser } from "@/lib/auth/require-user";
import { listBrandsForUser } from "@/lib/brands";
import { getActiveBrand } from "@/lib/auth/active-brand";

// getActiveBrand, NOT requireActiveBrand: this layout wraps /onboarding, so a
// redirect-on-null here would send a brandless account to /onboarding, whose
// layout would redirect it again — an infinite loop. The layout tolerates a
// null brand and renders the sidebar without a switcher; the individual pages
// that genuinely need a brand are the ones that redirect.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const brands = await listBrandsForUser(user.id);
  const active = await getActiveBrand(user.id);

  return (
    <div className="flex min-h-screen">
      <aside className="w-52 shrink-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border p-4 flex flex-col gap-1">
        <div className="flex items-center gap-2 mb-6 px-1">
          <TrainIcon className="h-7 w-7 text-primary" />
          <div className="font-heading font-bold leading-tight tracking-wide">
            <div className="text-sm">CONTENT</div>
            <div className="text-sm text-primary -mt-0.5">ENGINE</div>
          </div>
        </div>
        {active && <BrandSwitcher brands={brands} activeId={active.id} />}
        <NavLinks />
        <form action="/auth/signout" method="post" className="mt-auto">
          <Button variant="ghost" size="sm" type="submit">Sign out</Button>
        </form>
      </aside>
      <main className="flex-1 p-6 bg-grid">{children}</main>
      <Toaster />
    </div>
  );
}
