import type { ReactNode } from "react";

/** Eyebrow + display title + lede — the standard rish.pw section opener. */
export function PageIntro({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="display-title mt-3">{title}</h1>
      {/* Reserve a fixed slot for the lede (up to ~3 lines at leading-7) so the
          accent divider lands at the same vertical position on every page,
          regardless of how many lines each page's lede wraps to. */}
      <div className="mt-5 max-w-xl min-h-[5.25rem]">
        {lede ? <p className="text-[0.95rem] leading-7 text-muted">{lede}</p> : null}
      </div>
      <div className="accent-divider mt-8" aria-hidden="true" />
    </div>
  );
}
