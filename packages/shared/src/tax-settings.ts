// Zod-free: the quote UI, checkout and the PDF all use it. Validation of what
// admin sends lives in tax-settings-schema.ts.

/**
 * GST the shop adds to its quotations (admin → Settings → GST). Not to be
 * confused with `costBasis.gstRate`, the GST the shop pays on the spools it
 * buys (profit estimate only). When on, GST is added on top of the printing,
 * setup fee and shipping; there is no B2B/B2C logic and this is never a tax
 * invoice. Off by default: quotes read exactly as before.
 */
export interface TaxSettings {
  enabled: boolean;
  /** Rate in basis points: 1800 = 18%. */
  rateBp: number;
  /** HSN or SAC code printed on the quotation (4–8 digits). */
  hsn: string;
  /** The shop's GSTIN. */
  gstin: string;
}

/** What the quote UI needs. */
export interface PublicTax {
  enabled: boolean;
  rateBp: number;
}

export const DEFAULT_TAX: TaxSettings = { enabled: false, rateBp: 1800, hsn: "", gstin: "" };

export const TAX_RATE_MAX_BP = 2800;
/** 2 digits state code, PAN (5 letters, 4 digits, letter), entity number, Z, checksum. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const HSN_RE = /^[0-9]{4,8}$/;

/** GST on an amount, rounded to the paisa. */
export function taxOn(amountPaise: number, rateBp: number): number {
  return Math.round((amountPaise * rateBp) / 10_000);
}

/** "18%", "12.5%". */
export function formatTaxRate(rateBp: number): string {
  return `${Number((rateBp / 100).toFixed(2))}%`;
}

/** The totals of a quotation with GST: everything taxable is printing + setup
 *  fee (`quotePaise`, priceQuote's total) + shipping. */
export function withTax(
  quotePaise: number,
  shippingPaise: number,
  tax: PublicTax | null | undefined,
): { taxPaise: number; grandTotalPaise: number } {
  const taxable = quotePaise + shippingPaise;
  const taxPaise = tax?.enabled ? taxOn(taxable, tax.rateBp) : 0;
  return { taxPaise, grandTotalPaise: taxable + taxPaise };
}
