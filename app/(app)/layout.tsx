import { Button } from "@/components/ui/button";
import { TrainIcon } from "@/components/train-icon";
import { NavLinks } from "./nav-links";

export default function AppLayout({ children }: { children: React.ReactNode }) {
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
        <NavLinks />
        <form action="/auth/signout" method="post" className="mt-auto">
          <Button variant="ghost" size="sm" type="submit">Sign out</Button>
        </form>
      </aside>
      <main className="flex-1 p-6 bg-grid">{children}</main>
    </div>
  );
}
