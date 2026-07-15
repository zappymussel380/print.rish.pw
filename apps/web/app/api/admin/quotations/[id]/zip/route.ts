import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { UUID_RE } from "@print/shared";
import { contentDispositionFilename, jsonError, requireAdminApi } from "@/lib/api-util";
import { env } from "@/lib/env";
import { modelPath, openPrivateFile, pdfPath } from "@/lib/storage";
import {
  createZipStream,
  sanitizeArchiveName,
  uniqueArchiveName,
  type ZipStreamEntry,
} from "@/lib/zip-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Bundle a quotation's model files and its PDF into one streamed zip, so the
 *  admin can pull a whole order without clicking through per-model Telegram
 *  links. Files that are unavailable (retention, failed PDF render) are listed
 *  in MISSING_FILES.txt instead of failing the download. */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return jsonError(404, "NOT_FOUND", "Quotation not found");

  const quotation = await prisma.quotation.findUnique({
    where: { id },
    include: { items: { include: { model: true } } },
  });
  if (!quotation) return jsonError(404, "NOT_FOUND", "Quotation not found");

  // Plan the whole manifest before streaming: every file is opened (and its
  // descriptor validated) up front, so a broken file can still become a
  // MISSING_FILES.txt line rather than a mid-stream abort.
  const entries: ZipStreamEntry[] = [];
  const missing: string[] = [];
  const taken = new Set<string>();
  try {
    for (const item of quotation.items) {
      const { model } = item;
      const desired = sanitizeArchiveName(model.originalName, `model.${model.format}`);
      const name = uniqueArchiveName(desired, taken);
      if (!model.storedPath) {
        missing.push(name);
        continue;
      }
      try {
        const opened = await openPrivateFile(
          modelPath(model.id, model.format),
          env.maxUploadBytes,
          model.sizeBytes,
        );
        entries.push({
          name,
          handle: opened.handle,
          size: opened.size,
          store: model.format === "3mf",
        });
      } catch {
        missing.push(name);
      }
    }

    const pdfName = uniqueArchiveName(`${quotation.number}.pdf`, taken);
    try {
      const opened = await openPrivateFile(pdfPath(quotation.number), MAX_PDF_BYTES);
      entries.push({ name: pdfName, handle: opened.handle, size: opened.size, store: false });
    } catch {
      missing.push(pdfName);
    }
  } catch (err) {
    await Promise.all(entries.map((entry) => entry.handle.close().catch(() => {})));
    throw err;
  }

  return new NextResponse(createZipStream(entries, missing), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDispositionFilename(`${quotation.number}.zip`),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
