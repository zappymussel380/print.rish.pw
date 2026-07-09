import { formatDuration, formatGrams } from "@print/shared";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_CHARS = 3900;
const SEND_TIMEOUT_MS = 5_000;

const money = (paise: number) =>
  `Rs ${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100)}`;

function singleLine(value: string | null | undefined, max = 160): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function absoluteUrl(path: string, origin: string): string {
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
}

function fitTelegramMessage(message: string, adminUrl: string): string {
  if (message.length <= MAX_MESSAGE_CHARS) return message;
  const suffix = `\n\n...truncated. Open admin for the full order:\n${adminUrl}`;
  return `${message.slice(0, MAX_MESSAGE_CHARS - suffix.length).trimEnd()}${suffix}`;
}

export interface TelegramQuotationLine {
  modelId: string;
  fileName: string;
  material: string;
  colour: string;
  layerHeightUm: number;
  infillPct: number;
  supports: string;
  quantity: number;
  totalGrams: number;
  totalPrintSeconds: number;
  subtotalPaise: number;
}

export interface NewQuotationTelegramInput {
  number: string;
  customer: {
    name: string;
    email: string;
    phone: string;
    city: string;
    notes?: string | null;
  };
  lines: TelegramQuotationLine[];
  totalPaise: number;
  shippingPaise: number;
  shippingPincode: string | null;
  appOrigin?: string;
}

export function buildNewQuotationTelegramMessage(input: NewQuotationTelegramInput): string {
  const origin = input.appOrigin ?? env.appOrigin;
  const adminUrl = absoluteUrl("/admin", origin);
  const totalQuantity = input.lines.reduce((sum, line) => sum + line.quantity, 0);
  const totalGrams = input.lines.reduce((sum, line) => sum + line.totalGrams, 0);
  const totalSeconds = input.lines.reduce((sum, line) => sum + line.totalPrintSeconds, 0);
  const shipping =
    input.shippingPaise > 0
      ? `${money(input.shippingPaise)} to ${input.shippingPincode ?? "unknown pincode"}`
      : "not included";

  const parts = [
    "New print order",
    `Quotation: ${input.number}`,
    `Total: ${money(input.totalPaise)} (${input.lines.length} model${input.lines.length === 1 ? "" : "s"}, ${totalQuantity} print${totalQuantity === 1 ? "" : "s"})`,
    `Filament/time: ${formatGrams(totalGrams)}, ${formatDuration(totalSeconds)}`,
    `Shipping: ${shipping}`,
    "",
    `Customer: ${singleLine(input.customer.name, 120)}`,
    `Phone: ${singleLine(input.customer.phone, 80)}`,
    `Email: ${singleLine(input.customer.email, 120)}`,
    `City: ${singleLine(input.customer.city, 120)}`,
  ];

  const notes = singleLine(input.customer.notes, 350);
  if (notes) parts.push(`Notes: ${notes}`);

  parts.push("", `Admin: ${adminUrl}`, "", "Files:");

  input.lines.forEach((line, index) => {
    const downloadUrl = absoluteUrl(`/api/models/${line.modelId}/file`, origin);
    parts.push(
      `${index + 1}. ${singleLine(line.fileName, 140)}`,
      `   ${line.material} ${line.colour}, ${(line.layerHeightUm / 1000).toFixed(2)}mm, ${line.infillPct}% infill, supports ${line.supports}, qty ${line.quantity}`,
      `   ${formatGrams(line.totalGrams)}, ${formatDuration(line.totalPrintSeconds)}, ${money(line.subtotalPaise)}`,
      `   ${downloadUrl}`,
    );
  });

  return fitTelegramMessage(parts.join("\n"), adminUrl);
}

export async function notifyNewQuotation(input: NewQuotationTelegramInput): Promise<void> {
  const token = env.telegramBotToken.trim();
  const chatId = env.telegramChatId.trim();
  if (!token || !chatId) return;

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: buildNewQuotationTelegramMessage(input),
    disable_web_page_preview: true,
  };
  const threadId = env.telegramMessageThreadId;
  if (threadId) payload.message_thread_id = threadId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      let description = response.statusText;
      try {
        const json = (await response.json()) as { description?: string };
        description = json.description ?? description;
      } catch {
        /* keep status text */
      }
      logger.warn({ status: response.status, description }, "telegram notification failed");
      return;
    }

    logger.info({ quotationNumber: input.number }, "telegram notification sent");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "telegram notification failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}
