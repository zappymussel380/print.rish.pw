import { formatPaise } from "./money";

/** Builds the wa.me handoff URL sent after a quotation is submitted. */

export interface WhatsAppMessageInput {
  /** International format without '+', e.g. "919876543210". */
  number: string;
  quotationNumber: string;
  customerName: string;
  /** e.g. "2× PLA (black), 1× PETG (white)" */
  materialsSummary: string;
  totalPaise: number;
  /** Prepaid shipping folded into totalPaise; 0 means the quote excludes
   *  shipping. Required (not optional) so the message can never silently
   *  present a materials-only total as the amount owed — payment is agreed
   *  in this chat, so an excluded-shipping quote must say so. */
  shippingPaise: number;
  shippingPincode: string | null;
  notes?: string;
}

const MAX_NOTES_CHARS = 500;

export function buildWhatsAppMessage(input: Omit<WhatsAppMessageInput, "number">): string {
  const lines = [
    `Hi! I just submitted quotation *${input.quotationNumber}* on print.rish.pw.`,
    ``,
    `Name: ${input.customerName}`,
    `Items: ${input.materialsSummary}`,
    `Estimated total: ${formatPaise(input.totalPaise)}`,
    input.shippingPaise > 0
      ? `Shipping: ${formatPaise(input.shippingPaise)}${input.shippingPincode ? ` to ${input.shippingPincode}` : ""} (included in total)`
      : `Shipping: not included — to be confirmed`,
  ];
  const notes = input.notes?.trim();
  if (notes) {
    const clipped = notes.length > MAX_NOTES_CHARS ? `${notes.slice(0, MAX_NOTES_CHARS)}…` : notes;
    lines.push(`Notes: ${clipped}`);
  }
  lines.push(``, `Looking forward to hearing from you!`);
  return lines.join("\n");
}

export function buildWhatsAppUrl(input: WhatsAppMessageInput): string {
  const number = input.number.replace(/[^0-9]/g, "");
  if (!number) {
    throw new Error("WhatsApp number is not configured");
  }
  return `https://wa.me/${number}?text=${encodeURIComponent(buildWhatsAppMessage(input))}`;
}
