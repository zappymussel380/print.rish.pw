"use client";

import { useEffect, useRef } from "react";
import { MessageCircle } from "lucide-react";

/** Prominent WhatsApp CTA on the confirmation page. Attempts a single
 *  new-tab open on mount (pop-up blockers may prevent it — the button always
 *  works as the reliable fallback). */
export function WhatsAppLaunch({ url }: { url: string }) {
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    window.open(url, "_blank", "noopener");
  }, [url]);

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="btn-pill">
      <MessageCircle strokeWidth={2} className="h-4 w-4" />
      Continue on WhatsApp
    </a>
  );
}
