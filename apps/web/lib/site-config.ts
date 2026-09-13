/** Server-side view of business configuration coming from the environment.
 *  Import only from server components / route handlers. */

function googleMapsEmbedUrl(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      (url.hostname === "www.google.com" || url.hostname === "google.com") &&
      url.pathname.startsWith("/maps/embed")
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

export const siteConfig = {
  get appOrigin() {
    return process.env.APP_ORIGIN ?? "http://localhost:3000";
  },
  get whatsappNumber() {
    return (process.env.WHATSAPP_NUMBER ?? "").replace(/[^0-9]/g, "");
  },
  get googleMapsEmbedUrl() {
    return googleMapsEmbedUrl(process.env.GOOGLE_MAPS_EMBED_URL);
  },
};


