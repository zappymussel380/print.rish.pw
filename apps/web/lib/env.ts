/** Typed server-side environment access with development defaults.
 *  Secrets have NO defaults — missing values fail loudly at first use. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const isProduction = process.env.NODE_ENV === "production";
const PLACEHOLDER_RE = /^(?:change-me|changeme|password|secret|example)(?:[-_].*)?$/i;

function secret(name: string, minBytes = 32): string {
  const value = required(name);
  if (Buffer.byteLength(value, "utf8") < minBytes || PLACEHOLDER_RE.test(value)) {
    throw new Error(`${name} must be at least ${minBytes} bytes and not a placeholder`);
  }
  return value;
}

function appOrigin(): string {
  const raw = process.env.APP_ORIGIN;
  if (!raw && isProduction) throw new Error("Missing required environment variable APP_ORIGIN");
  let url: URL;
  try {
    url = new URL(raw ?? "http://localhost:3000");
  } catch {
    throw new Error("APP_ORIGIN must be a valid absolute origin");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_ORIGIN must contain only scheme, host, and optional port");
  }
  if (isProduction && url.protocol !== "https:") {
    throw new Error("APP_ORIGIN must use HTTPS in production");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("APP_ORIGIN must use HTTP or HTTPS");
  }
  return url.origin;
}

function redisUrl(): string {
  const raw = process.env.REDIS_URL;
  if (!raw && isProduction) throw new Error("Missing required environment variable REDIS_URL");
  let url: URL;
  try {
    url = new URL(raw ?? "redis://localhost:6379");
  } catch {
    throw new Error("REDIS_URL must be a valid Redis URL");
  }
  if (!["redis:", "rediss:"].includes(url.protocol)) throw new Error("REDIS_URL must use redis:// or rediss://");
  const password = decodeURIComponent(url.password);
  if (
    isProduction &&
    (Buffer.byteLength(password, "utf8") < 32 || PLACEHOLDER_RE.test(password))
  ) {
    throw new Error("REDIS_URL must include a non-placeholder password of at least 32 bytes in production");
  }
  return url.toString();
}

function databaseUrl(): string {
  const raw = required("DATABASE_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use postgresql://");
  }
  const password = decodeURIComponent(url.password);
  if (
    isProduction &&
    (Buffer.byteLength(password, "utf8") < 32 || PLACEHOLDER_RE.test(password))
  ) {
    throw new Error("DATABASE_URL must include a non-placeholder password of at least 32 bytes in production");
  }
  return raw;
}

function bcryptHash(): string {
  const value = required("ADMIN_PASSWORD_HASH");
  const match = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(value);
  if (!match || Number(match[1]) < 12) {
    throw new Error("ADMIN_PASSWORD_HASH must be a valid bcrypt hash with cost 12 or higher");
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const HARD_MAX_UPLOAD_MB = 300;

export const env = {
  get databaseUrl() {
    return databaseUrl();
  },
  get redisUrl() {
    return redisUrl();
  },
  get sessionSecret() {
    return secret("SESSION_SECRET");
  },
  get adminPasswordHash() {
    return bcryptHash();
  },
  get appOrigin() {
    return appOrigin();
  },
  get uploadDir() {
    return process.env.UPLOAD_DIR ?? "./data/uploads";
  },
  get pdfDir() {
    return process.env.PDF_DIR ?? "./data/pdfs";
  },
  get maxUploadBytes() {
    return Math.min(int("MAX_UPLOAD_MB", HARD_MAX_UPLOAD_MB), HARD_MAX_UPLOAD_MB) * 1024 * 1024;
  },
  get maxUploadMb() {
    return this.maxUploadBytes / 1024 / 1024;
  },
  get maxSessionUploadBytes() {
    return int("MAX_SESSION_UPLOAD_MB", 900) * 1024 * 1024;
  },
  get uploadWindowBytes() {
    return int("UPLOAD_WINDOW_MB", 900) * 1024 * 1024;
  },
  get downloadWindowBytes() {
    return int("DOWNLOAD_WINDOW_MB", 1200) * 1024 * 1024;
  },
  get storageReserveBytes() {
    return int("STORAGE_RESERVE_MB", 2048) * 1024 * 1024;
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
