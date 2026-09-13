"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_SITE_PROFILE } from "@print/shared";

/** The parts of the shop profile client components render. Supplied once by
 *  the root layout, so no client code fetches or hardcodes the brand. */
export interface SiteIdentity {
  brandName: string;
  city: string;
}

const SiteContext = createContext<SiteIdentity>({
  brandName: DEFAULT_SITE_PROFILE.brandName,
  city: DEFAULT_SITE_PROFILE.city,
});

export function SiteProvider({ value, children }: { value: SiteIdentity; children: ReactNode }) {
  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteIdentity {
  return useContext(SiteContext);
}
