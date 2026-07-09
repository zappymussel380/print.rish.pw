/** Typed server-side environment access with development defaults.
 *  Secrets have NO defaults — missing values fail loudly at first use. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get redisUrl() {
    return process.env.REDIS_URL ?? "redis://localhost:6379";
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  get adminPasswordHash() {
    return required("ADMIN_PASSWORD_HASH");
  },
  get appOrigin() {
    return process.env.APP_ORIGIN ?? "http://localhost:3000";
  },
  get uploadDir() {
    return process.env.UPLOAD_DIR ?? "./data/uploads";
  },
  get pdfDir() {
    return process.env.PDF_DIR ?? "./data/pdfs";
  },
  get maxUploadBytes() {
    return int("MAX_UPLOAD_MB", 100) * 1024 * 1024;
  },
  get maxModelsPerSession() {
    return int("MAX_MODELS_PER_SESSION", 20);
  },
  get uploadRetentionHours() {
    return int("UPLOAD_RETENTION_HOURS", 48);
  },
  get fileRetentionDays() {
    return int("FILE_RETENTION_DAYS", 30);
  },
  // Contact form → Resend. Secrets have no defaults so a misconfigured deploy
  // fails loudly at send time rather than silently dropping messages.
  get resendApiKey() {
    return required("RESEND_API_KEY");
  },
  get mailTo() {
    return required("MAIL_TO");
  },
  get contactFrom() {
    return process.env.CONTACT_FROM ?? "print.rish.pw <contact@rish.pw>";
  },
  // Optional Telegram order notifications. Empty values disable notifications
  // without affecting checkout.
  get telegramBotToken() {
    return process.env.TELEGRAM_BOT_TOKEN ?? "";
  },
  get telegramChatId() {
    return process.env.TELEGRAM_CHAT_ID ?? "";
  },
  get telegramMessageThreadId() {
    const raw = process.env.TELEGRAM_MESSAGE_THREAD_ID;
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  },
  // Shiprocket rate calculator. Credentials are secrets (no defaults) so a
  // misconfigured deploy returns NOT_CONFIGURED instead of silently failing.
  get shiprocketEmail() {
    return required("SHIPROCKET_EMAIL");
  },
  get shiprocketPassword() {
    return required("SHIPROCKET_PASSWORD");
  },
  get shiprocketPickupPincode() {
    return process.env.SHIPROCKET_PICKUP_PINCODE ?? "781001";
  },
};
