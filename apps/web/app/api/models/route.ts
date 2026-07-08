import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { assertBodySize, jsonError } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";
import { removeQuietly } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many *unattached* models the current quote session holds — uploads not
 *  yet part of a submitted quotation. The client quote store is not persisted,
 *  so after a reload the on-screen quote is empty while these rows persist and
 *  keep counting against MAX_MODELS_PER_SESSION; the quote page uses this to
 *  offer a cleanup. Quoted models are excluded so this count matches exactly the
 *  set DELETE can remove (and the upload cap counts) — otherwise the banner
 *  would report orphans the "Clear them" action can never clear. */
export async function GET() {
  const sessionId = await getQuoteSessionId();
  if (!sessionId) return NextResponse.json({ count: 0 });
  const count = await prisma.uploadedModel.count({
    where: { sessionId, items: { none: {} } },
  });
  return NextResponse.json({ count });
}

/** Clear this session's *stranded* uploads — unattached to any quotation AND not
 *  currently on the client's screen (files, thumbnails, rows). Mirrors the
 *  retention sweep. The shared slice cache (keyed by fileHash) is untouched, so
 *  re-uploading is instant.
 *
 *  The client sends `keep`: the server ids of the models still in its quote
 *  builder. Those must survive even though they're unattached (a model stays
 *  unattached until checkout) — deleting one would strand the live quote, since
 *  the UI keeps showing a model whose row/file is gone and slicing/checkout then
 *  fails. Everything else unattached is genuinely orphaned (e.g. left over after
 *  a page reload) and safe to remove. */
export async function DELETE(request: NextRequest) {
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const sessionId = await getQuoteSessionId();
  if (!sessionId) return NextResponse.json({ cleared: 0 });

  // A keep-list of at most maxModelsPerSession UUIDs — anything bigger is abuse.
  const tooLarge = assertBodySize(request, 16 * 1024);
  if (tooLarge) return tooLarge;

  // Parse the preserve-list defensively: a missing/invalid body means "keep
  // nothing" (the cleanup-after-reload case, where the client has no models).
  let keep: string[] = [];
  try {
    const body = (await request.json()) as { keep?: unknown };
    if (Array.isArray(body.keep)) keep = body.keep.filter((x): x is string => typeof x === "string");
  } catch {
    /* no/invalid JSON body */
  }

  const stale = await prisma.uploadedModel.findMany({
    // Only add the id filter when there's something to keep — `notIn: []` has
    // had inconsistent semantics across Prisma versions; omitting it is the
    // unambiguous "no exclusion" (clear everything unattached) case.
    where: { sessionId, items: { none: {} }, ...(keep.length ? { id: { notIn: keep } } : {}) },
    select: { id: true, storedPath: true, thumbPath: true },
  });

  let cleared = 0;
  for (const model of stale) {
    // Delete the row FIRST, re-asserting `items: { none: {} }` in the same
    // statement. Prisma compiles this to a single atomic `DELETE ... WHERE NOT
    // EXISTS(items)`, so a checkout that attached this model between the
    // findMany above and here wins the race: count comes back 0 and we leave
    // its files on disk. Only once we own the deletion do we unlink the
    // artefacts — never before, so a live quotation can't lose its files.
    const { count } = await prisma.uploadedModel.deleteMany({
      where: { id: model.id, items: { none: {} } },
    });
    if (count === 0) continue;
    await removeQuietly(model.storedPath);
    await removeQuietly(model.thumbPath);
    cleared += 1;
  }
  return NextResponse.json({ cleared });
}
