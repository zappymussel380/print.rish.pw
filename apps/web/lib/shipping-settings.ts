import { cache } from "react";
import { type Prisma, prisma } from "@print/db";
import { normalizeShippingSettings, type ShippingAdminView, type ShippingSettings } from "@print/shared";
import { env } from "./env";
import { openSecret } from "./secret-box";

/** Key of the JSON row in `AppSetting` holding admin → Shipping. */
export const SHIPPING_KEY = "shipping";

/** Purpose the Shiprocket password is sealed for (see secret-box). */
export const SHIPROCKET_PASSWORD_PURPOSE = "shiprocket-password";

/** The settings the estimator runs on right now. */
export interface ShippingConfig {
  source: ShippingAdminView["source"];
  /** Customers see the estimator: switched on and fully set up. */
  live: boolean;
  enabled: boolean;
  email: string;
  /** In the clear, server-side only; empty when there is none. */
  password: string;
  passwordUnreadable: boolean;
  pickupPincode: string;
}

/** What admin → Shipping saved, or null when it never has. */
export async function getStoredShipping(): Promise<ShippingSettings | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: SHIPPING_KEY } });
  return normalizeShippingSettings(row?.value ?? null);
}

/** The environment's settings, as every install used before admin → Shipping
 *  existed (and print.rish.pw still does). */
function fromEnv(): ShippingConfig {
  const email = process.env.SHIPROCKET_EMAIL ?? "";
  const password = process.env.SHIPROCKET_PASSWORD ?? "";
  const configured = email !== "" && password !== "";
  return {
    source: configured ? "env" : "none",
    live: configured,
    enabled: configured,
    email,
    password,
    passwordUnreadable: false,
    pickupPincode: env.shiprocketPickupPincode,
  };
}

function fromSaved(saved: ShippingSettings): ShippingConfig {
  const password = saved.passwordSealed ? openSecret(saved.passwordSealed, SHIPROCKET_PASSWORD_PURPOSE) : null;
  return {
    source: "saved",
    live: saved.enabled && saved.email !== "" && password !== null && password !== "" && saved.pickupPincode !== "",
    enabled: saved.enabled,
    email: saved.email,
    password: password ?? "",
    passwordUnreadable: saved.passwordSealed !== "" && password === null,
    pickupPincode: saved.pickupPincode,
  };
}

/** Saved settings win; otherwise the environment. */
export function resolveShippingConfig(saved: ShippingSettings | null): ShippingConfig {
  return saved ? fromSaved(saved) : fromEnv();
}

/** The live settings. A database hiccup falls back to the environment, so the
 *  quote page never breaks over it. */
export const getShippingConfig = cache(async (): Promise<ShippingConfig> => {
  try {
    return resolveShippingConfig(await getStoredShipping());
  } catch {
    return fromEnv();
  }
});

export function toAdminView(config: ShippingConfig): ShippingAdminView {
  return {
    source: config.source,
    enabled: config.enabled,
    email: config.email,
    // With nothing set up, the environment's pincode is only docker-compose's
    // Guwahati default; don't offer it as if the shop had chosen it.
    pickupPincode: config.source === "none" ? "" : config.pickupPincode,
    hasPassword: config.password !== "",
    passwordUnreadable: config.passwordUnreadable,
    live: config.live,
  };
}

export async function saveShipping(settings: ShippingSettings): Promise<void> {
  const value = settings as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: SHIPPING_KEY },
    create: { key: SHIPPING_KEY, value },
    update: { value },
  });
}
