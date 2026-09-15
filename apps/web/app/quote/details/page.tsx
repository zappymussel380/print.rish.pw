import type { Metadata } from "next";
import { PageIntro } from "@/components/shell/page-intro";
import { CheckoutForm } from "@/components/quote/checkout-form";
import { getRetention } from "@/lib/retention-settings";

export const metadata: Metadata = {
  title: "Review & submit",
  description: "Review your 3D-printing quote and share your contact details to receive it.",
};

export default async function QuoteDetailsPage() {
  const { policy } = await getRetention();
  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="Almost there"
        title="Review & submit"
        lede="Check your order, add your details, and we'll generate your quotation and hand off to WhatsApp."
      />
      <CheckoutForm quotationRetentionDays={policy.quotationRetentionDays} />
    </div>
  );
}
