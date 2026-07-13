import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { CATALOG, modelConfigSchema, type BoundingBoxMm, type ModelConfig } from "@print/shared";
import { guardMutation, readJsonBody } from "@/lib/api-util";
import { RATE_LIMITS } from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";
import { modelPath, removeQuietly, thumbPath } from "@/lib/storage";
import type { UploadedModelDto } from "@/lib/upload-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RestorableModelRow = {
  id: string;
  originalName: string;
  format: string;
  sizeBytes: number;
  bboxXMm: number | null;
  bboxYMm: number | null;
  bboxZMm: number | null;
  volumeCm3: number | null;
  defaultConfig: unknown;
  sourceConfig: unknown;
  lockedConfig: unknown;
};

function fitsBed(bboxMm: BoundingBoxMm): boolean {
  const bed = CATALOG.printers[CATALOG.defaultPrinterId]!.bedMm;
  const dims = [bboxMm.x, bboxMm.y, bboxMm.z].sort((a, b) => a - b);
  const bedSorted = [...bed].sort((a, b) => a - b);
  return dims.every((d, i) => d <= bedSorted[i]!);
}

function serializeModel(model: RestorableModelRow): UploadedModelDto {
  const bboxMm = {
    x: model.bboxXMm ?? 0,
    y: model.bboxYMm ?? 0,
    z: model.bboxZMm ?? 0,
  };

  return {
    id: model.id,
    originalName: model.originalName,
    format: model.format,
    sizeBytes: model.sizeBytes,
    bboxMm,
    volumeCm3: model.volumeCm3 ?? 0,
    fitsBed: fitsBed(bboxMm),
    defaultConfig: parseDefaultConfig(model.defaultConfig),
    sourceConfig: parseDefaultConfig(model.sourceConfig),
    lockedConfig: parseLockedConfig(model.lockedConfig),
  };
}

function parseDefaultConfig(value: unknown): Partial<ModelConfig> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = modelConfigSchema.partial().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseLockedConfig(value: unknown): Partial<Record<keyof ModelConfig, true>> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const locks: Partial<Record<keyof ModelConfig, true>> = {};
  const record = value as Record<string, unknown>;
  for (const key of ["material", "colour", "layerHeightUm", "infillPct", "supports", "quantity"] as const) {
    if (record[key] === true) locks[key] = true;
  }
  return Object.keys(locks).length > 0 ? locks : undefined;
}

/** How many *unattached* models the current quote session holds — uploads not
 *  yet part of a submitted quotation. The client quote store is not persisted,
 *  so after a reload the on-screen quote is empty while these rows persist and
 *  keep counting against MAX_MODELS_PER_SESSION; the quote page uses this to
 *  offer a restore/cleanup choice. Quoted models are excluded so this count
 *  matches exactly the set DELETE can remove (and the upload cap counts) —
 *  otherwise the banner would report models the clear action can never clear. */
export async function GET(request: NextRequest) {
  const includeModels = request.nextUrl.searchParams.get("include") === "models";
  const sessionId = await getQuoteSessionId();
  if (!sessionId) return NextResponse.json(includeModels ? { count: 0, models: [] } : { count: 0 });

  if (includeModels) {
    const models = await prisma.uploadedModel.findMany({
      where: { sessionId, items: { none: {} } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        originalName: true,
        format: true,
        sizeBytes: true,
        bboxXMm: true,
        bboxYMm: true,
        bboxZMm: true,
        volumeCm3: true,
        defaultConfig: true,
        sourceConfig: true,
        lockedConfig: true,
      },
    });
    return NextResponse.json({ count: models.length, models: models.map(serializeModel) });
  }

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
  const guard = await guardMutation(request, "modelMutation", RATE_LIMITS.modelMutation);
  if (guard) return guard;
  const sessionId = await getQuoteSessionId();
  if (!sessionId) return NextResponse.json({ cleared: 0 });

  // A keep-list of at most maxModelsPerSession UUIDs — anything bigger is abuse.
  // Parse the preserve-list defensively: a missing/invalid body means "keep
  // nothing" (the cleanup-after-reload case, where the client has no models).
  let keep: string[] = [];
  const parsedBody = await readJsonBody(request, 16 * 1024);
  if (!parsedBody.ok && parsedBody.response.status === 413) return parsedBody.response;
  if (parsedBody.ok) {
    const body = parsedBody.value as { keep?: unknown };
    if (Array.isArray(body?.keep)) keep = body.keep.filter((x): x is string => typeof x === "string");
  }

  const stale = await prisma.uploadedModel.findMany({
    // Only add the id filter when there's something to keep — `notIn: []` has
    // had inconsistent semantics across Prisma versions; omitting it is the
    // unambiguous "no exclusion" (clear everything unattached) case.
    where: { sessionId, items: { none: {} }, ...(keep.length ? { id: { notIn: keep } } : {}) },
    select: { id: true, format: true },
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
    await removeQuietly(modelPath(model.id, model.format));
    await removeQuietly(thumbPath(model.id));
    cleared += 1;
  }
  return NextResponse.json({ cleared });
}
