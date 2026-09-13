import { Mail, MapPin, MessageCircle, Phone } from "lucide-react";
import type { Metadata } from "next";
import { ContactForm } from "@/components/contact/contact-form";
import { PageIntro } from "@/components/shell/page-intro";
import { siteConfig } from "@/lib/site-config";
import { getSiteProfile, profileWhatsappUrl } from "@/lib/site-profile";

export async function generateMetadata(): Promise<Metadata> {
  const { brandName, city } = await getSiteProfile();
  return {
    title: "Contact",
    description: `Reach ${brandName} by WhatsApp or the contact form.${city ? ` Based in ${city}, India.` : ""}`,
  };
}

// Rendered per request so runtime contact links and embeds are available
// (they aren't available at Docker build time, when static pages are baked).
export const dynamic = "force-dynamic";

export default async function ContactPage() {
  const profile = await getSiteProfile();
  const waUrl = profileWhatsappUrl(profile, "Hi! I have a question about 3D printing.");
  const { email, phone, address } = profile.contact;
  const phoneHref = phone.replace(/[^0-9+]/g, "");

  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="Contact"
        title="Say hello"
        lede="WhatsApp is the fastest way to reach us. It is where quotations are confirmed, materials are discussed and progress photos get shared."
      />

      <div className="mx-auto mt-12 grid max-w-3xl gap-4 sm:grid-cols-2">
        <div className="tile tile-hover flex flex-col p-6 sm:col-span-2">
          <MessageCircle strokeWidth={1.65} className="size-6 text-accent" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-[650]">WhatsApp</h2>
          <p className="mt-1.5 text-sm leading-6 text-muted">
            Quotes, questions, progress updates: everything happens here. Expect a reply within
            business hours, often much faster.
          </p>
          <div className="mt-auto pt-5">
            {waUrl ? (
              <a href={waUrl} className="btn-pill" rel="noopener noreferrer" target="_blank">
                Chat on WhatsApp
              </a>
            ) : (
              <p className="text-sm text-faint">WhatsApp number not configured.</p>
            )}
          </div>
        </div>

        {email || phone || address ? (
          <div className="tile flex flex-col gap-3 p-6 text-sm sm:col-span-2">
            <h2 className="text-lg font-[650]">Other ways to reach us</h2>
            {email ? (
              <p className="flex items-center gap-2.5">
                <Mail strokeWidth={1.65} className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <a href={`mailto:${email}`} className="underline decoration-accent underline-offset-4 hover:text-accent">
                  {email}
                </a>
              </p>
            ) : null}
            {phone ? (
              <p className="flex items-center gap-2.5">
                <Phone strokeWidth={1.65} className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <a href={`tel:${phoneHref}`} className="underline decoration-accent underline-offset-4 hover:text-accent">
                  {phone}
                </a>
              </p>
            ) : null}
            {address ? (
              <p className="flex items-start gap-2.5">
                <MapPin strokeWidth={1.65} className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="whitespace-pre-line text-muted">{address}</span>
              </p>
            ) : null}
          </div>
        ) : null}

        <ContactForm />
      </div>

      {siteConfig.googleMapsEmbedUrl ? (
        <div className="mx-auto mt-4 max-w-3xl">
          <div className="tile overflow-hidden p-0">
            <iframe
              src={siteConfig.googleMapsEmbedUrl}
              sandbox="allow-scripts allow-same-origin allow-popups"
              title="Location map"
              className="h-72 w-full"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              allowFullScreen
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
