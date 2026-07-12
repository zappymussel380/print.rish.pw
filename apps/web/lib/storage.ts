import { constants } from "node:fs";
import { chmod, mkdir, open, rename, statfs, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { env } from "./env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_FORMATS = new Set(["stl", "3mf", "obj", "amf"]);
const QUOTATION_NUMBER_RE = /^RSP-\d{4}-\d{4,}$/;

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
  if (!UUID_RE.test(modelId) || !MODEL_FORMATS.has(format)) {
    throw new Error("Invalid model storage identity");
  }
  return join(uploadRoot(), `${modelId}.${format}`);
}

export function thumbPath(modelId: string): string {
  if (!UUID_RE.test(modelId)) throw new Error("Invalid thumbnail storage identity");
  return join(uploadRoot(), "thumbs", `${modelId}.png`);
}

export function pdfPath(quotationNumber: string): string {
  if (!QUOTATION_NUMBER_RE.test(quotationNumber)) {
    throw new Error("Invalid quotation storage identity");
  }
  return join(pdfRoot(), `${quotationNumber}.pdf`);
}

export async function ensureStorageDirs(): Promise<void> {
  const privateDirs = [uploadRoot(), join(uploadRoot(), "thumbs"), join(uploadRoot(), "tmp"), pdfRoot()];
  for (const dir of privateDirs) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
}

export async function hasStorageHeadroom(requiredBytes: number): Promise<boolean> {
  return (await availableStorageBytes()) >= requiredBytes;
}

export async function hasPdfStorageHeadroom(requiredBytes: number): Promise<boolean> {
  const stats = await statfs(pdfRoot());
  return stats.bavail * stats.bsize >= requiredBytes;
}

export async function availableStorageBytes(): Promise<number> {
  const stats = await statfs(uploadRoot());
  return stats.bavail * stats.bsize;
}

export function tmpUploadPath(): string {
  return join(uploadRoot(), "tmp", crypto.randomUUID());
}

export async function moveIntoPlace(tmp: string, final: string): Promise<void> {
  await rename(tmp, final);
}

export interface OpenedPrivateFile {
  handle: FileHandle;
  size: number;
}

/** Open a trusted storage artifact without following a symlink, then validate
 * the already-open descriptor. This closes the DB-path/symlink TOCTOU present
 * when routes used stat(path) followed by createReadStream(path). */
export async function openPrivateFile(
  path: string,
  maxBytes: number,
  expectedBytes?: number,
): Promise<OpenedPrivateFile> {
  if (!isInsideStorage(path)) throw new Error("Refusing to open a path outside private storage");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size <= 0 ||
      info.size > maxBytes ||
      (expectedBytes !== undefined && info.size !== expectedBytes)
    ) {
      throw new Error("Stored file has an invalid type or size");
    }
    return { handle, size: info.size };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

export async function readPrivateFile(
  path: string,
  maxBytes: number,
  expectedBytes?: number,
): Promise<Buffer> {
  const { handle } = await openPrivateFile(path, maxBytes, expectedBytes);
  try {
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

function isInsideStorage(path: string): boolean {
  const candidate = resolve(path);
  return [uploadRoot(), pdfRoot()].some((root) => {
    const rel = relative(root, candidate);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
}

export async function removeQuietly(path: string | null | undefined): Promise<void> {
  if (!path) return;
  if (!isInsideStorage(path)) throw new Error("Refusing to remove a path outside private storage");
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
