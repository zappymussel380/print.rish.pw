import { mkdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { env } from "./env";

/** Paths for customer files. Everything lives under UPLOAD_DIR / PDF_DIR —
 *  named Docker volumes in production, ./data in development — never under
 *  the web root. Stored names are always server-generated UUIDs. */

export function uploadRoot(): string {
  return resolve(env.uploadDir);
}

export function pdfRoot(): string {
  return resolve(env.pdfDir);
}

export function modelPath(modelId: string, format: string): string {
  return join(uploadRoot(), `${modelId}.${format}`);
}

export function thumbPath(modelId: string): string {
  return join(uploadRoot(), "thumbs", `${modelId}.png`);
}

export function pdfPath(quotationNumber: string): string {
  return join(pdfRoot(), `${quotationNumber}.pdf`);
}

export async function ensureStorageDirs(): Promise<void> {
  await mkdir(join(uploadRoot(), "thumbs"), { recursive: true });
  await mkdir(join(uploadRoot(), "tmp"), { recursive: true });
  await mkdir(pdfRoot(), { recursive: true });
}

export function tmpUploadPath(): string {
  return join(uploadRoot(), "tmp", crypto.randomUUID());
}

export async function moveIntoPlace(tmp: string, final: string): Promise<void> {
  await rename(tmp, final);
}

export async function removeQuietly(path: string | null | undefined): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch {
    // Already gone — retention job or a concurrent delete beat us to it.
  }
}
