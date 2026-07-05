import type { Metadata } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/shell/site-footer";
import { SiteHeader } from "@/components/shell/site-header";
import "./globals.css";

const inter = localFont({
  src: "../public/fonts/inter-var.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: "print.rish.pw — instant 3D printing quotes",
    template: "%s — print.rish.pw",
  },
  description:
    "Upload STL, 3MF, OBJ or AMF models and get an instant, transparent 3D-printing quotation. PLA and PETG on a Bambu Lab A1, priced from real slicing data.",
};

// Applies the persisted theme before first paint; identical key ("rish-theme")
// and attribute (data-theme) to the main rish.pw site.
const themeInit = `(function(){try{var t=localStorage.getItem("rish-theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans bg-bg text-text min-h-dvh flex flex-col`}>
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInit}
        </Script>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 btn-pill"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
