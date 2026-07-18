"use client";

import { House, LayoutDashboard, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import ThemeToggle from "./theme-toggle";
import UserMenu from "./user-menu";

const links = [
  { href: "/", label: "Home", icon: House },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
] as const;

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-separator bg-surface max-md:w-16">
      <div className="flex items-center gap-2.5 px-4 py-5 max-md:justify-center max-md:px-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Zap className="size-4" />
        </div>
        <span className="truncate font-semibold max-md:hidden">Demo Stack</span>
      </div>

      <nav className="flex flex-col gap-1 px-3 max-md:px-2">
        {links.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href;
          return (
            <Link
              key={href}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors max-md:justify-center max-md:px-2 ${
                isActive
                  ? "bg-accent-soft font-medium text-accent-soft-foreground"
                  : "text-muted hover:bg-default-soft hover:text-foreground"
              }`}
              href={href}
            >
              <Icon className="size-4 shrink-0" />
              <span className="max-md:hidden">{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex items-center gap-2 border-t border-separator p-3 max-md:flex-col max-md:p-2">
        <div className="min-w-0 flex-1 max-md:w-full">
          <UserMenu />
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}
