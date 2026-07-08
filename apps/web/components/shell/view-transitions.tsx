"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * Cross-fades route changes with the browser's native View Transitions API —
 * no experimental React APIs required. A capture-phase click listener catches
 * internal link navigations, wraps the router push in
 * `document.startViewTransition`, and resolves the transition only once the new
 * route has committed (detected via the pathname effect) so the API snapshots
 * the *new* DOM. The old page fades out while the new one fades in; see the
 * `::view-transition-*` rules in globals.css. Degrades to instant navigation
 * where the API is unavailable or the user prefers reduced motion.
 */
export function ViewTransitions({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const finish = useRef<(() => void) | null>(null);

  // The route just committed — let any pending transition snapshot the new DOM.
  useEffect(() => {
    if (finish.current) {
      finish.current();
      finish.current = null;
    }
  }, [pathname]);

  useEffect(() => {
    const doc = document as Document & {
      startViewTransition?: (cb: () => Promise<void> | void) => unknown;
    };
    if (typeof doc.startViewTransition !== "function") return;

    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      const target = anchor.getAttribute("target");
      if ((target && target !== "_self") || anchor.hasAttribute("download")) return;

      const raw = anchor.getAttribute("href");
      if (!raw) return;
      let url: URL;
      try {
        url = new URL(raw, location.href);
      } catch {
        return;
      }
      // Only intercept internal *page* navigations to a different path. API
      // routes (file downloads, attachments like the admin CSV export) must
      // keep their native browser behaviour — router.push would hijack them.
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      if (url.pathname.startsWith("/api/")) return;

      e.preventDefault();
      const href = url.pathname + url.search + url.hash;
      doc.startViewTransition!(
        () =>
          new Promise<void>((resolve) => {
            const done = () => resolve();
            finish.current = done;
            router.push(href);
            // Safety valve: never leave the transition overlay hanging if the
            // route somehow doesn't commit.
            setTimeout(() => {
              if (finish.current === done) {
                finish.current = null;
                resolve();
              }
            }, 700);
          }),
      );
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router]);

  return <>{children}</>;
}
