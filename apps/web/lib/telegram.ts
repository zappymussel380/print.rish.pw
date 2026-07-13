import { formatDuration, formatGrams } from "@print/shared";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_CHARS = 3900;
const SEND_TIMEOUT_MS = 5_000;
const OPERATOR_ALERT_INTERVAL_SECONDS = 15 * 60;
const OPERATOR_ALERT_INTERVAL_MS = OPERATOR_ALERT_INTERVAL_SECONDS * 1000;

export type OperatorAlertKind =
  | "checkout_5xx"
  | "quotation_pdf_failure"
  | "shipping_daily_cap"
  | "ingest_busy"
  | "upload_busy"
  | "worker_heartbeat";

interface LocalAlertState {
  blockedUntil: number;
  suppressed: number;
}

const localAlertStates = new Map<OperatorAlertKind, LocalAlertState>();

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

function telegramTarget(): { token: string; chatId: string } | null {
  const token = env.telegramBotToken.trim();
  const chatId = env.telegramChatId.trim();
  return token && chatId ? { token, chatId } : null;
}

async function sendTelegramMessage(message: string): Promise<boolean> {
  const target = telegramTarget();
  if (!target) return false;

  const payload: Record<string, unknown> = {
    chat_id: target.chatId,
    text: message.slice(0, MAX_MESSAGE_CHARS),
    disable_web_page_preview: true,
  };
  const threadId = env.telegramMessageThreadId;
  if (threadId) payload.message_thread_id = threadId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${target.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      logger.warn({ status: response.status }, "telegram notification failed");
      return false;
    }

    return true;
  } catch (err) {
    // Do not log the request URL: it contains the Telegram bot token.
    logger.warn(
      { errorType: err instanceof Error ? err.name : "unknown" },
      "telegram notification failed",
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function localAlertState(kind: OperatorAlertKind): LocalAlertState {
  const existing = localAlertStates.get(kind);
  if (existing) return existing;
  const created = { blockedUntil: 0, suppressed: 0 };
  localAlertStates.set(kind, created);
  return created;
}

function alertRateKey(kind: OperatorAlertKind): string {
  return `operator-alert:${kind}`;
}

function alertSuppressedKey(kind: OperatorAlertKind): string {
  return `operator-alert-suppressed:${kind}`;
}

async function recordSuppressedAlert(
  kind: OperatorAlertKind,
  state: LocalAlertState,
): Promise<void> {
  try {
    await redis.incr(alertSuppressedKey(kind));
  } catch {
    state.suppressed += 1;
  }
}

function parseSuppressedCount(value: string | null): number {
  if (!value) return 0;
  const count = Number.parseInt(value, 10);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

async function claimOperatorAlert(kind: OperatorAlertKind): Promise<number | null> {
  const state = localAlertState(kind);
  const now = Date.now();
  if (state.blockedUntil > now) {
    await recordSuppressedAlert(kind, state);
    return null;
  }

  // Claim the process-local window before the first await. If Redis is down,
  // concurrent callers must not all fall through and send the same alert.
  state.blockedUntil = now + OPERATOR_ALERT_INTERVAL_MS;

  let claimed: boolean;
  try {
    claimed =
      (await redis.set(
        alertRateKey(kind),
        "1",
        "EX",
        OPERATOR_ALERT_INTERVAL_SECONDS,
        "NX",
      )) === "OK";
  } catch {
    // Redis outages must not silence the alert which reports that outage. This
    // process-local gate still caps a storm, while healthy replicas coordinate
    // through the shared key above.
    const suppressed = state.suppressed;
    state.suppressed = 0;
    return suppressed;
  }

  if (!claimed) {
    // Mirror the shared decision locally. Besides reducing Redis traffic, this
    // keeps the cap in force if Redis becomes unavailable during this window.
    await recordSuppressedAlert(kind, state);
    return null;
  }

  let sharedSuppressed = 0;
  try {
    sharedSuppressed = parseSuppressedCount(await redis.getdel(alertSuppressedKey(kind)));
  } catch {
    // Keep the shared counter for a later alert if Redis only failed briefly.
  }
  const suppressed = sharedSuppressed + state.suppressed;
  state.suppressed = 0;
  return suppressed;
}

function buildOperatorAlertMessage(
  kind: OperatorAlertKind,
  message: string,
  suppressed: number,
): string {
  const prefix = `Operator alert: ${kind}\n`;
  const suffix =
    suppressed > 0
      ? `\n\n${suppressed} similar alert${suppressed === 1 ? " was" : "s were"} suppressed since the previous notification.`
      : "";
  const available = Math.max(0, MAX_MESSAGE_CHARS - prefix.length - suffix.length);
  const trimmed = message.trim();
  const body =
    trimmed.length <= available
      ? trimmed
      : `${trimmed.slice(0, Math.max(0, available - 3)).trimEnd()}...`;
  return `${prefix}${body}${suffix}`;
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
  if (await sendTelegramMessage(buildNewQuotationTelegramMessage(input))) {
    logger.info({ quotationNumber: input.number }, "telegram notification sent");
  }
}

/** Send a bounded, per-kind operational alert. Telegram and Redis failures are
 * intentionally contained so alerting can never turn a customer-facing error
 * into a second failure. */
export async function sendOperatorAlert(
  kind: OperatorAlertKind,
  message: string,
): Promise<void> {
  try {
    if (!telegramTarget()) return;
    const suppressed = await claimOperatorAlert(kind);
    if (suppressed === null) return;
    await sendTelegramMessage(buildOperatorAlertMessage(kind, message, suppressed));
  } catch {
    // This function is used from best-effort error paths and must never reject.
  }
}
