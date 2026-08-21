import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import {
  MAX_SHOWCASE_PHOTO_BYTES,
  recentPrintsSchema,
  toPublicRecentPrints,
} from "@print/shared";
import { jsonError, readBinaryBody, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { ImageRejected, sanitizeImage } from "@/lib/image-sanitize";
import { getRecentPrints, saveRecentPrints } from "@/lib/recent-prints";
import { assertSameOrigin } from "@/lib/security";
import { ensureStorageDirs, showcasePath } from "@/lib/storage";
import { pruneUnreferencedShowcasePhotos } from "@/lib/showcase-photos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

/** Admin: the current showcase, in display order. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json({ prints: toPublicRecentPrints(await getRecentPrints()) });
}

/** Admin: upload one photo. Returns the id that now addresses it on disk; the
 *  caller adds it to the list with a caption via PUT. Kept separate from the
 *  metadata write so a photo is never half-described, and so the editor can
 *  keep managing the whole ordered list in one payload. */
export async function POST(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const body = await readBinaryBody(request, MAX_SHOWCASE_PHOTO_BYTES);
  if (!body.ok) return body.response;

  let photo;
  try {
    // Identify by structure, never by the declared Content-Type, and re-emit
    // without the metadata containers — a phone photo carries GPS.
    photo = sanitizeImage(body.value);
  } catch (error) {
    if (error instanceof ImageRejected) return jsonError(422, "BAD_IMAGE", error.message);
    throw error;
  }

  const id = randomUUID();
  await ensureStorageDirs();
  await writeFile(showcasePath(id, photo.kind), photo.bytes, { flag: "wx", mode: 0o600 });

  return NextResponse.json({ id, photoExt: photo.kind }, { status: 201 });
}

/** Admin: replace the whole showcase. Normalized on save, so entries that
 *  could not address a real photo are dropped rather than stored. Photos left
 *  unreferenced afterwards are removed, which is also how deletion works. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;

  const parsed = recentPrintsSchema.safeParse(body.value);
  if (!parsed.success) return jsonError(422, "BAD_REQUEST", "Invalid showcase payload");

  const previous = await getRecentPrints();
  const saved = await saveRecentPrints(parsed.data);
  await pruneUnreferencedShowcasePhotos(saved, previous);
  return NextResponse.json({ prints: toPublicRecentPrints(saved) });
}
