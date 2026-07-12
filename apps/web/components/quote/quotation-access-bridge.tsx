"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function QuotationAccessBridge({ number }: { number: string }) {
  const router = useRouter();
  const [state, setState] = useState<"checking" | "invalid">("checking");

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!token) {
      setState("invalid");
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/quotations/${encodeURIComponent(number)}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Access denied");
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        router.refresh();
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setState("invalid");
      });
    return () => controller.abort();
  }, [number, router]);

  return (
    <div className="mx-auto max-w-lg px-5 py-24 text-center">
      <p className="eyebrow">{state === "checking" ? "Checking link" : "Not found"}</p>
      <h1 className="display-title mt-3 text-4xl">
        {state === "checking" ? "Opening your quotation…" : "Can’t open this quotation"}
      </h1>
      <p className="mt-5 text-muted">
        {state === "checking"
          ? "Verifying the private access link."
          : "This link is invalid or has expired. If you just submitted a quote, use the exact link you were given."}
      </p>
      {state === "invalid" && (
        <Link href="/quote" className="btn-pill mt-8">
          Start a new quote
        </Link>
      )}
    </div>
  );
}

export function ClearQuotationAccessFragment() {
  useEffect(() => {
    if (new URLSearchParams(window.location.hash.slice(1)).has("token")) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, []);
  return null;
}
