// Zod-free: the admin editor imports these. Validation lives in
// shipping-settings-schema.ts.

/**
 * Live courier estimates on the quote page, through the shop's Shiprocket API
 * user. Stored as one JSON app setting once the owner saves it in admin →
 * Shipping; until then the server's environment (SHIPROCKET_*) is used, so an
 * install configured that way keeps working untouched. With neither, the quote
 * page has no estimator and checkout says shipping is arranged afterwards.
 */
export interface ShippingSettings {
  /** Show the estimator to customers. */
  enabled: boolean;
  /** The Shiprocket API user's email. */
  email: string;
  /** The API user's password, sealed with the server's secret — never stored
   *  or sent to the browser in the clear. Empty when there is none. */
  passwordSealed: string;
  /** Where parcels leave from: the pickup address's pincode. */
  pickupPincode: string;
}

/** What admin → Shipping shows. Never carries the password. */
export interface ShippingAdminView {
  /** Where the live settings come from. */
  source: "saved" | "env" | "none";
  enabled: boolean;
  email: string;
  pickupPincode: string;
  hasPassword: boolean;
  /** A saved password the server can no longer read (its secret changed). */
  passwordUnreadable: boolean;
  /** Customers see the estimator right now. */
  live: boolean;
}

/** An Indian pincode: six digits, not starting with 0. */
export const PICKUP_PINCODE_RE = /^[1-9][0-9]{5}$/;

export const SHIPPING_EMAIL_MAX = 254;
