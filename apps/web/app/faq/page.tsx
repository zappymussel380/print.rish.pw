import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/shell/page-intro";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Frequently asked questions: file formats, turnaround, maximum size, colours, shipping, layer lines and durability.",
};

const faqs: { q: string; a: string }[] = [
  {
    q: "Which file formats can I upload?",
    a: "STL, 3MF, OBJ and AMF. STL is the safest export from almost any CAD tool. If your software offers 3MF, prefer it — it preserves units and orientation more reliably.",
  },
  {
    q: "How accurate is the instant quote?",
    a: "Very — it isn't an estimate from geometry, your file is actually sliced by OrcaSlicer with the same Bambu Lab A1 profile the printer runs. The filament weight and print time in your quote come from the generated toolpath itself.",
  },
  {
    q: "What's the maximum printable size?",
    a: "256 × 256 × 256 mm — the Bambu Lab A1's full build volume. Larger parts can often be split and joined; message us on WhatsApp and we'll advise.",
  },
  {
    q: "Which colours are available?",
    a: "Black and white, in both PLA and PETG, kept permanently in stock. Other colours can usually be arranged on request — ask on WhatsApp before ordering.",
  },
  {
    q: "How long until I get my prints?",
    a: "Your quote shows an estimated completion date based on total print time plus a small buffer for preparation and quality checks. Most small orders are ready in 2–4 days. Local pickup in Guwahati is same-day once printing finishes.",
  },
  {
    q: "Do you ship?",
    a: "Yes — anywhere in India via courier at actual shipping cost, agreed on WhatsApp after your quotation. Pickup in Guwahati is free.",
  },
  {
    q: "Will I see layer lines?",
    a: "Yes — every FDM print has them; they're the nature of the process. At 0.12 mm layer height they're subtle and mostly disappear at arm's length. Choose 0.12 mm for display pieces and 0.20 mm for functional parts where speed and price matter more.",
  },
  {
    q: "How durable are printed parts?",
    a: "Very usable in daily life. PLA parts handle static indoor loads well; PETG takes impacts, heat up to ~80 °C and outdoor exposure. Strength also depends on print orientation and infill — if a part is load-bearing, say so in the notes and we'll orient and tune it accordingly.",
  },
  {
    q: "What about supports — do they leave marks?",
    a: "Overhanging geometry needs support material, which is included in your quoted weight. After removal there can be slight surface marks on supported faces. 'Auto' lets the slicer decide where supports are needed; choose 'Off' only if you know your model prints support-free.",
  },
  {
    q: "How do I pay?",
    a: "There's no online payment here — submitting a quotation costs nothing and commits you to nothing. We confirm details on WhatsApp first; payment is UPI or bank transfer once you approve the final quote.",
  },
  {
    q: "How long do you keep my files and details?",
    a: "Uploads that never become a quotation request are deleted automatically within 48 hours. Model files attached to an order are removed 30 days after completion. Our live quotation record, PDF, contact details, delivery details and remaining local files have a retention period of at most 90 days after completion or cancellation, then the next daily cleanup removes them. We store and use those details only to process the order. We never analyze or sell them, or use them for marketing. Processing may share them with the operator's WhatsApp, Telegram and email accounts and the shipping provider; provider and backup copies follow their own retention schedules.",
  },
];

export default function FaqPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="FAQ"
        title="Questions, answered"
        lede="Everything customers usually ask before their first order. Anything missing? WhatsApp us — replies are quick during business hours."
      />

      <div className="mx-auto mt-12 max-w-3xl space-y-3">
        {faqs.map((item) => (
          <details key={item.q} className="tile group p-0">
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
            <p className="border-t border-line p-5 text-sm leading-7 text-muted">{item.a}</p>
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
