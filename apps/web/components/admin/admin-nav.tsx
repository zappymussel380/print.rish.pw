"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

const SECTIONS = [
  { href: "/admin", label: "Home" },
  { href: "/admin/filament", label: "Filament" },
  { href: "/admin/site", label: "Site" },
  { href: "/admin/recent-prints", label: "Recent prints" },
  { href: "/admin/settings", label: "Settings" },
] as const;

/** The admin sections, as a row of links that scrolls sideways on a phone. */
export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" } });
    router.push("/admin/login");
    router.refresh();
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-line">
      <nav aria-label="Admin" className="-mb-px flex min-w-0 gap-1 overflow-x-auto">
        {SECTIONS.map((s) => {
          const active = s.href === "/admin" ? pathname === "/admin" : pathname === s.href || pathname.startsWith(`${s.href}/`);
          return (
            <Link
              key={s.href}
              href={s.href}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-[550] transition-colors ${
                active ? "border-[var(--accent)] text-accent" : "border-transparent text-muted hover:text-text"
              }`}
            >
              {s.label}
            </Link>
          );
        })}
      </nav>
      <button type="button" onClick={logout} className="btn-ghost mb-1.5 shrink-0 text-sm">
        <LogOut strokeWidth={1.8} className="h-4 w-4" /> <span className="hidden sm:inline">Sign out</span>
      </button>
    </div>
  );
}

