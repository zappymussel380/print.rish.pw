import { z } from "zod";
import { PICKUP_PINCODE_RE, SHIPPING_EMAIL_MAX, type ShippingSettings } from "./shipping-settings";

/** What admin → Shipping sends. The password is write-only: absent or empty
 *  keeps the current one. */
export const shippingSettingsInputSchema = z.object({
  enabled: z.boolean(),
  email: z.string().trim().max(SHIPPING_EMAIL_MAX),
  password: z.string().max(200).optional(),
  pickupPincode: z.string().trim().max(6),
});
export type ShippingSettingsInput = z.infer<typeof shippingSettingsInputSchema>;

const emailSchema = z.email().max(SHIPPING_EMAIL_MAX);

export function isShippingEmail(value: string): boolean {
  return emailSchema.safeParse(value).success;
}

/** A stored blob, hardened: null when there is nothing usable (the caller
 *  then falls back to the environment). Fields that don't validate are
 *  blanked, which leaves the estimator off rather than half-configured. */
export function normalizeShippingSettings(raw: unknown): ShippingSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const email = text(r.email);
  const pickupPincode = text(r.pickupPincode);
  return {
    enabled: r.enabled === true,
    email: isShippingEmail(email) ? email : "",
    passwordSealed: text(r.passwordSealed),
    pickupPincode: PICKUP_PINCODE_RE.test(pickupPincode) ? pickupPincode : "",
  };
}
