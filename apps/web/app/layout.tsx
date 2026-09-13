import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import Script from "next/script";
import type { ReactNode } from "react";
import { listJoin, materialFamily, MATERIAL_IDS } from "@print/shared";
import { SiteFooter } from "@/components/shell/site-footer";
import { SiteHeader } from "@/components/shell/site-header";
import { ViewTransitions } from "@/components/shell/view-transitions";
import { getCatalogAvailability } from "@/lib/catalog-availability";
import { getPricing } from "@/lib/pricing-settings";
import { SiteProvider } from "@/lib/site-context";
import { getSiteProfile } from "@/lib/site-profile";
import "./globals.css";

const inter = localFont({
  src: "../public/fonts/inter-var.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-inter",
});

export async function generateMetadata(): Promise<Metadata> {
  const [profile, availability, { catalog }] = await Promise.all([
    getSiteProfile(),
    getCatalogAvailability(),
    getPricing(),
  ]);
  // Name the base polymers on offer ("PLA and PETG"), not every tier.
  const families = [
    ...new Set(MATERIAL_IDS.filter((m) => availability.materials[m]).map(materialFamily)),
  ];
  const printer = catalog.printers[catalog.defaultPrinterId]!.name;
  const offer = families.length > 0 ? `${listJoin(families)} on a ${printer}` : `Printed on a ${printer}`;
  return {
    title: {
      default: profile.tagline ? `${profile.brandName} — ${profile.tagline}` : profile.brandName,
      template: `%s — ${profile.brandName}`,
    },
    description: `Upload STL, 3MF, OBJ or AMF models and get an instant, transparent 3D-printing quotation. ${offer}, priced from real slicing data.`,
  };
}

// Applies explicit theme overrides before first paint. With no saved override,
// CSS follows the browser's preferred color scheme.
const themeInit = `(function(){try{var t=localStorage.getItem("rish-theme");var d=document.documentElement;if(t==="light"||t==="dark"){d.setAttribute("data-theme",t);}else{d.removeAttribute("data-theme");}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const profile = await getSiteProfile();
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans bg-bg text-text min-h-dvh flex flex-col`}>
        <Script id="theme-init" strategy="beforeInteractive" nonce={nonce}>
          {themeInit}
        </Script>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 btn-pill"
        >
          Skip to content
        </a>
        <SiteProvider value={{ brandName: profile.brandName, city: profile.city }}>
          <ViewTransitions>
            <SiteHeader />
            <main id="main" className="flex-1">
              {children}
            </main>
            <SiteFooter note={profile.footerNote} city={profile.city} brandName={profile.brandName} />
          </ViewTransitions>
        </SiteProvider>
      </body>
    </html>
  );
}
