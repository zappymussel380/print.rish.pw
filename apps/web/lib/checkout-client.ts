import type { Customer, ModelConfig } from "@print/shared";

export interface CheckoutItem {
  modelId: string;
  config: ModelConfig;
}

export interface CheckoutResult {
  number: string;
  accessToken: string;
  pdfUrl: string;
  whatsappUrl: string | null;
}

export interface CheckoutError {
  code: string;
  message: string;
  issues?: Record<string, string[]>;
}

export async function submitQuotation(
  items: CheckoutItem[],
  customer: Customer,
): Promise<CheckoutResult> {
  const res = await fetch("/api/quotations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ items, customer }),
  });
  if (!res.ok) {
    let err: CheckoutError = { code: "SUBMIT_FAILED", message: `Submission failed (HTTP ${res.status})` };
    try {
      const body = (await res.json()) as { error?: CheckoutError };
      if (body.error) err = body.error;
    } catch {
      /* non-JSON */
    }
    throw err;
  }
  return (await res.json()) as CheckoutResult;
}
