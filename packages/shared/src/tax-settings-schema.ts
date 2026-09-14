import { z } from "zod";
import { DEFAULT_TAX, GSTIN_RE, HSN_RE, TAX_RATE_MAX_BP, type TaxSettings } from "./tax-settings";

/** What admin → Settings → GST sends; the rate as a percentage. */
export const taxInputSchema = z.object({
  enabled: z.boolean(),
  ratePct: z.number().min(0).max(TAX_RATE_MAX_BP / 100),
  hsn: z.string().trim().max(8),
  gstin: z.string().trim().toUpperCase().max(15),
});
export type TaxInput = z.infer<typeof taxInputSchema>;

/** A stored blob, hardened: anything invalid falls back to off/defaults, so a
 *  damaged row can never add GST by itself. */
export function normalizeTax(raw: unknown): TaxSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_TAX };
  const r = raw as Record<string, unknown>;
  const rateBp = typeof r.rateBp === "number" && Number.isInteger(r.rateBp) && r.rateBp >= 0 && r.rateBp <= TAX_RATE_MAX_BP ? r.rateBp : DEFAULT_TAX.rateBp;
  const hsn = typeof r.hsn === "string" && HSN_RE.test(r.hsn) ? r.hsn : "";
  const gstin = typeof r.gstin === "string" && GSTIN_RE.test(r.gstin) ? r.gstin : "";
  // On only with everything a quotation needs to show.
  return { enabled: r.enabled === true && hsn !== "" && gstin !== "" && rateBp > 0, rateBp, hsn, gstin };
}
