import type { ReactNode } from "react";

/** Title block at the top of each admin page. */
export function AdminPageHeader({ title, lede, children }: { title: string; lede?: string; children?: ReactNode }) {
  return (
    <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="section-title">{title}</h1>
        {lede ? <p className="mt-1.5 max-w-2xl text-sm text-muted">{lede}</p> : null}
      </div>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </div>
  );
}
