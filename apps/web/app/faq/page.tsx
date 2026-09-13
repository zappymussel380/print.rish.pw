import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/shell/page-intro";
import { getFaq } from "@/lib/faq";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Frequently asked questions: file formats, turnaround, maximum size, colours, shipping, layer lines and durability.",
};

/** Answered from this shop's own settings, plus any entries it added itself. */
export default async function FaqPage() {
  const faqs = await getFaq();
  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="FAQ"
        title="Questions, answered"
        lede="Everything customers usually ask before their first order. Anything missing? Get in touch — we're happy to help."
      />

      <div className="mx-auto mt-12 max-w-3xl space-y-3">
        {faqs.map((item) => (
          <details key={item.id} className="tile group p-0">
            <summary className="cursor-pointer list-none p-5 text-[0.95rem] font-[650] transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
              <span className="flex items-center justify-between gap-4">
                {item.q}
                <span
                  aria-hidden="true"
                  className="text-faint transition-transform duration-300 group-open:rotate-45"
                >
                  +
                </span>
              </span>
            </summary>
            <div className="border-t border-line p-5">
              <p className="text-sm leading-7 text-muted">{item.a}</p>
              {item.more && (
                <Link
                  href={item.more.href}
                  className="mt-3 inline-block text-sm text-accent underline decoration-accent underline-offset-4"
                >
                  {item.more.label}
                </Link>
              )}
            </div>
          </details>
        ))}
      </div>

      <div className="mx-auto mt-12 max-w-3xl">
        <Link href="/contact" className="btn-ghost">
          Still curious? Contact us
        </Link>
      </div>
    </div>
  );
}
