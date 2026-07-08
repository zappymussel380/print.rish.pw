"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { PrinterMark } from "./printer-mark";
import { ThemeToggle } from "./theme-toggle";

const nav = [
  { href: "/quote", label: "Get a quote" },
  { href: "/pricing", label: "Pricing" },
  { href: "/materials", label: "Materials" },
  { href: "/faq", label: "FAQ" },
  { href: "/contact", label: "Contact" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile menu on navigation.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-[18px]">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-2 font-[650] tracking-[0.02em]">
          <PrinterMark className="size-5 shrink-0 text-accent" />
          <span>
            <span className="text-accent">print</span>
            <span className="text-text">.rish.pw</span>
          </span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {nav.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3.5 py-2 text-sm font-[550] transition-colors ${
                  active
                    ? "text-accent"
                    : "text-muted hover:text-text"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          <button
            type="button"
            className="grid size-10 place-items-center rounded-full text-muted transition-colors hover:text-accent md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X strokeWidth={1.65} className="size-5" /> : <Menu strokeWidth={1.65} className="size-5" />}
          </button>
        </div>
      </div>

      {open && (
        <nav
          id="mobile-nav"
          aria-label="Main"
          className="border-t border-line px-5 pb-4 pt-2 md:hidden"
        >
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-lg px-2 py-2.5 text-sm font-[550] text-muted transition-colors hover:text-text"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
