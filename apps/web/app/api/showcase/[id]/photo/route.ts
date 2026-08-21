import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { MAX_SHOWCASE_PHOTO_BYTES, UUID_RE } from "@print/shared";
import { jsonError } from "@/lib/api-util";
import { getRecentPrints } from "@/lib/recent-prints";
import { openPrivateFile, showcasePath } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES = { jpg: "image/jpeg", png: "image/png" } as const;

/** Public: serve one showcase photo.
 *
 * Unlike model thumbnails these are deliberately public and cacheable — they
 * are marketing images the admin chose to publish. The id must appear in the
 * saved showcase, so an arbitrary UUID cannot be used to probe storage. */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return jsonError(404, "NOT_FOUND", "No photo");

  const print = (await getRecentPrints()).find((entry) => entry.id === id);
  if (!print) return jsonError(404, "NOT_FOUND", "No photo");

  let opened: Awaited<ReturnType<typeof openPrivateFile>>;
  try {
    opened = await openPrivateFile(showcasePath(print.id, print.photoExt), MAX_SHOWCASE_PHOTO_BYTES);
  } catch {
    return jsonError(404, "NOT_FOUND", "No photo");
  }

  const stream = Readable.toWeb(opened.handle.createReadStream()) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": CONTENT_TYPES[print.photoExt],
      "Content-Length": String(opened.size),
      // The bytes at an id never change — a re-upload gets a new id.
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
