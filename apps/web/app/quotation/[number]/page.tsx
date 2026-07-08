import { timingSafeEqual } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { prisma } from "@print/db";
import {
  buildWhatsAppUrl,
  formatDuration,
  formatGrams,
  formatPaise,
  summariseItems,
} from "@print/shared";
import { WhatsAppLaunch } from "@/components/quote/whatsapp-launch";
import { siteConfig, whatsappChatUrl } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Quotation confirmed",
  robots: { index: false, follow: false },
};

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending review",
  QUOTED: "Quoted",
  APPROVED: "Approved",
  PRINTING: "Printing",
  COMPLETED: "Completed",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

function tokenMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export default async function ConfirmationPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { number } = await params;
  const { token } = await searchParams;

  const quotation = await prisma.quotation.findUnique({
    where: { number },
    include: { items: true },
  });

  if (!quotation || !token || !tokenMatches(token, quotation.accessToken)) {
    return (
      <div className="mx-auto max-w-lg px-5 py-24 text-center">
        <p className="eyebrow">Not found</p>
        <h1 className="display-title mt-3 text-4xl">Can&apos;t open this quotation</h1>
        <p className="mt-5 text-muted">
          This link is invalid or has expired. If you just submitted a quote, use the exact link you
          were given.
        </p>
        <Link href="/quote" className="btn-pill mt-8">
          Start a new quote
        </Link>
      </div>
    );
  }

  const materialsSummary = summariseItems(
    quotation.items.map((i) => ({ material: i.material, colour: i.colour, quantity: i.quantity })),
  );
  const whatsappUrl = siteConfig.whatsappNumber
    ? buildWhatsAppUrl({
        number: siteConfig.whatsappNumber,
        quotationNumber: quotation.number,
        customerName: quotation.customerName,
        materialsSummary,
        totalPaise: quotation.totalPaise,
        shippingPaise: quotation.shippingPaise,
        shippingPincode: quotation.shippingPincode,
        notes: quotation.notes,
      })
    : whatsappChatUrl();

  const pdfUrl = `/api/quotations/${quotation.number}/pdf?token=${token}`;

  return (
    <div className="mx-auto max-w-3xl px-5 py-16 sm:py-20">
      <p className="eyebrow">Quotation confirmed</p>
      <h1 className="display-title mt-3">You&apos;re all set</h1>
      <p className="mt-5 max-w-xl text-[0.95rem] leading-7 text-muted">
        Your quotation <span className="font-[650] text-text">{quotation.number}</span> is saved.
        Continue on WhatsApp to confirm materials, timeline and payment — your PDF is attached below.
      </p>
      <div className="accent-divider mt-8" aria-hidden="true" />

      <div className="mt-8 flex flex-wrap items-center gap-3">
        {whatsappUrl && <WhatsAppLaunch url={whatsappUrl} />}
        <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost">
          <Download strokeWidth={1.8} className="h-4 w-4" />
          Download PDF
        </a>
        <span className="chip chip-accent">{STATUS_LABEL[quotation.status] ?? quotation.status}</span>
      </div>

      <div className="tile mt-10 p-6">
        <p className="eyebrow text-[0.7rem]">Summary</p>
        <ul className="mt-4 divide-y divide-line">
          {quotation.items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-[600]">
                  {i.quantity > 1 ? `${i.quantity}× ` : ""}
                  {i.material} · {i.colour}
                </p>
                <p className="text-xs text-faint">
                  {(i.layerHeightUm / 1000).toFixed(2)}mm · {i.infillPct}% ·{" "}
                  {formatGrams(Number(i.unitGrams) * i.quantity)}
                </p>
              </div>
              <span className="font-[600]">{formatPaise(i.subtotalPaise)}</span>
            </li>
          ))}
        </ul>

        <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
          <div className="flex justify-between text-muted">
            <span>Setup fee</span>
            <span>{formatPaise(quotation.setupFeePaise)}</span>
          </div>
          {quotation.shippingPaise > 0 ? (
            <div className="flex justify-between text-muted">
              <span>Shipping{quotation.shippingPincode ? ` (to ${quotation.shippingPincode})` : ""}</span>
              <span>{formatPaise(quotation.shippingPaise)}</span>
            </div>
          ) : (
            <div className="flex justify-between text-muted">
              <span>Shipping</span>
              <span>Not included — confirmed over WhatsApp</span>
            </div>
          )}
          {quotation.estimatedCompletion && (
            <div className="flex justify-between text-muted">
              <span>Estimated ready</span>
              <span>{dateFmt.format(quotation.estimatedCompletion)}</span>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
          <span className="font-[650]">Total</span>
          <span className="text-2xl font-[750] text-accent">{formatPaise(quotation.totalPaise)}</span>
        </div>
      </div>

      <p className="mt-6 text-xs text-faint">
        Keep this link to reopen your quotation and PDF. This is an estimate, not a tax invoice.
      </p>
    </div>
  );
}
