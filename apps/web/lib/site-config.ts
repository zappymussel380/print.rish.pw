/** Server-side view of business configuration coming from the environment.
 *  Import only from server components / route handlers. */

export const siteConfig = {
  appOrigin: process.env.APP_ORIGIN ?? "http://localhost:3000",
  whatsappNumber: (process.env.WHATSAPP_NUMBER ?? "").replace(/[^0-9]/g, ""),
  contactEmail: process.env.CONTACT_EMAIL ?? "",
  googleMapsEmbedUrl: process.env.GOOGLE_MAPS_EMBED_URL ?? "",
};

export function whatsappChatUrl(text?: string): string | null {
  if (!siteConfig.whatsappNumber) return null;
  const base = `https://wa.me/${siteConfig.whatsappNumber}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}
