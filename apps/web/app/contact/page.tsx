import { Mail, MessageCircle } from "lucide-react";
import type { Metadata } from "next";
import { ContactForm } from "@/components/contact/contact-form";
import { PageIntro } from "@/components/shell/page-intro";
import { siteConfig, whatsappChatUrl } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Contact",
  description: "Reach print.rish.pw — WhatsApp first, email if you prefer. Based in Guwahati, India.",
};

// Rendered per request so the WhatsApp number / email reflect runtime env
// (they aren't available at Docker build time, when static pages are baked).
export const dynamic = "force-dynamic";

export default function ContactPage() {
  const waUrl = whatsappChatUrl("Hi! I have a question about 3D printing.");

  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="Contact"
        title="Say hello"
        lede="WhatsApp is the fastest way to reach us — it's where quotations are confirmed, materials are discussed and progress photos get shared."
      />

      <div className="mx-auto mt-12 grid max-w-3xl gap-4 sm:grid-cols-2">
        <div className="tile tile-hover flex flex-col p-6">
          <MessageCircle strokeWidth={1.65} className="size-6 text-accent" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-[650]">WhatsApp</h2>
          <p className="mt-1.5 text-sm leading-6 text-muted">
            Quotes, questions, progress updates — everything happens here. Expect a reply within
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

        <div className="tile tile-hover p-6">
          <Mail strokeWidth={1.65} className="size-6 text-accent" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-[650]">Email</h2>
          {siteConfig.contactEmail ? (
            <a
              href={`mailto:${siteConfig.contactEmail}`}
              className="mt-1.5 inline-block text-sm text-muted underline decoration-accent underline-offset-4 transition-colors hover:text-accent"
            >
              {siteConfig.contactEmail}
            </a>
          ) : (
            <p className="mt-1.5 text-sm text-faint">Email not configured.</p>
          )}
          <p className="mt-2 text-sm leading-6 text-muted">
            Better for detailed requirements, drawings or bulk enquiries.
          </p>
        </div>

        <ContactForm />
      </div>

      {siteConfig.googleMapsEmbedUrl ? (
        <div className="mx-auto mt-4 max-w-3xl">
          <div className="tile overflow-hidden p-0">
            <iframe
              src={siteConfig.googleMapsEmbedUrl}
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
