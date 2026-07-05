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
};
