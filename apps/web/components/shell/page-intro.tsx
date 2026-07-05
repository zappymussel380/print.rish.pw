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
      {lede ? <p className="mt-5 max-w-xl text-[0.95rem] leading-7 text-muted">{lede}</p> : null}
      <div className="accent-divider mt-8" aria-hidden="true" />
    </div>
  );
}
