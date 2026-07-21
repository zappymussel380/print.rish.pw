import { NextResponse, type NextRequest } from "next/server";
import { Prisma, prisma } from "@print/db";
import {
  assertConfigAvailable,
  type SliceJobData,
  sliceArtifactKey,
  sliceJobId,
  sliceSettingsSchema,
} from "@print/shared";
import { guardMutation, jsonError, readJsonBody } from "@/lib/api-util";
import { getCatalogAvailability } from "@/lib/catalog-availability";
import { normalizeModelConfigLocks } from "@/lib/model-config-locks";
import { getSliceQueue } from "@/lib/queue";
import { RATE_LIMITS } from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";
import { serializeSlice } from "@/lib/slice-serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Request a slice for a model at given settings. Idempotent:
 *  - cache hit (DONE/FAILED)      → returns the stored result immediately
 *  - already queued/running       → returns current status
 *  - miss                         → creates the cache row + enqueues, returns queued
 * The client then polls GET /api/slices/:sliceId.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "slice", RATE_LIMITS.slice);
  if (guard) return guard;

  const sessionId = await getQuoteSessionId();
  if (!sessionId) return jsonError(401, "NO_SESSION", "No quote session");

  // One modelId + one settings object — anything bigger is abuse.
  const parsedBody = await readJsonBody(request, 4 * 1024);
  if (!parsedBody.ok) return parsedBody.response;
  const payload = parsedBody.value;

  const parsed = sliceSettingsSchema.safeParse((payload as { settings?: unknown })?.settings);
  const modelId = (payload as { modelId?: unknown })?.modelId;
  if (typeof modelId !== "string" || !parsed.success) {
    return jsonError(422, "BAD_REQUEST", "Provide modelId and valid slice settings");
  }
  // Ownership: the model must belong to the caller's session.
  const model = await prisma.uploadedModel.findFirst({
    where: { id: modelId, sessionId },
  });
  if (!model) return jsonError(404, "NOT_FOUND", "Model not found in this session");
  const settings = normalizeModelConfigLocks(parsed.data, model);

  // Don't spend the worker on a material that's been turned off. Colour isn't a
  // slice setting, so only the material is checked here.
  const material = assertConfigAvailable(settings, await getCatalogAvailability());
  if (!material.ok) return jsonError(422, material.code, material.message);

  const key = sliceArtifactKey(model.format as "stl" | "3mf" | "obj" | "amf", settings);

  const existing = await prisma.sliceResult.findUnique({
    where: { fileHash_settingsKey: { fileHash: model.fileHash, settingsKey: key } },
  });
  if (existing) {
    // A previously failed slice is retried on explicit re-request.
    if (existing.status !== "FAILED") {
      if (existing.status === "QUEUED" || existing.status === "RUNNING") {
        await enqueue(existing.id, existing.attemptId, model, key, settings, {
          ensureLiveJob: true,
        });
      }
      return NextResponse.json(serializeSlice(existing));
    }
    const attemptId = crypto.randomUUID();
    const progressUpdatedAt = new Date();
    const retry = await prisma.sliceResult.updateMany({
      where: { id: existing.id, attemptId: existing.attemptId, status: "FAILED" },
      data: {
        attemptId,
        status: "QUEUED",
        progressPct: 0,
        progressStage: "queued",
        progressMessage: "Waiting for a slicer",
        progressUpdatedAt,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      },
    });
    if (retry.count !== 1) {
      const current = await prisma.sliceResult.findUnique({ where: { id: existing.id } });
      if (!current) {
        return jsonError(409, "SLICE_CHANGED", "Slice state changed; retry the request");
      }
      if (current.status === "QUEUED" || current.status === "RUNNING") {
        await enqueue(current.id, current.attemptId, model, key, settings, {
          ensureLiveJob: true,
        });
      }
      return NextResponse.json(serializeSlice(current));
    }
    // A retry has a fresh generation/job id. The prior BullMQ job may still be
    // leaving its active state, but its worker writes are generation-gated and
    // cannot overwrite this attempt.
    await enqueue(existing.id, attemptId, model, key, settings);
    return NextResponse.json(
      serializeSlice({
        ...existing,
        attemptId,
        status: "QUEUED",
        progressPct: 0,
        progressStage: "queued",
        progressMessage: "Waiting for a slicer",
        progressUpdatedAt,
        errorCode: null,
        errorMessage: null,
      }),
      { status: 202 },
    );
  }

  // Cache miss — create the row, tolerating a concurrent creator via the
  // (fileHash, settingsKey) unique constraint.
  let row;
  try {
    row = await prisma.sliceResult.create({
      data: {
        attemptId: crypto.randomUUID(),
        fileHash: model.fileHash,
        settingsKey: key,
        settingsJson: settings as unknown as Prisma.InputJsonValue,
        status: "QUEUED",
        slicerVersion: "",
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.sliceResult.findUnique({
        where: { fileHash_settingsKey: { fileHash: model.fileHash, settingsKey: key } },
      });
      if (winner) {
        if (winner.status === "QUEUED" || winner.status === "RUNNING") {
          await enqueue(winner.id, winner.attemptId, model, key, settings, {
            ensureLiveJob: true,
          });
        }
        return NextResponse.json(serializeSlice(winner));
      }
    }
    throw err;
  }

  await enqueue(row.id, row.attemptId, model, key, settings);
  return NextResponse.json(serializeSlice(row), { status: 202 });
}

async function enqueue(
  sliceResultId: string,
  attemptId: string,
  model: { id: string; fileHash: string; storedPath: string; format: string },
  key: string,
  settings: SliceJobData["settings"],
  options: { ensureLiveJob?: boolean } = {},
) {
  const queue = getSliceQueue();
  const jobId = sliceJobId(model.fileHash, key, attemptId);

  if (options.ensureLiveJob) {
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (["active", "delayed", "prioritized", "waiting", "waiting-children"].includes(state)) {
        return;
      }
    }

    // The worker writes the terminal database state before BullMQ marks the job
    // completed. Re-check after observing a non-live (or missing) queue job so a
    // request with a stale RUNNING snapshot cannot remove/requeue completed work.
    const current = await prisma.sliceResult.findUnique({
      where: { id: sliceResultId },
      select: { status: true, attemptId: true },
    });
    if (
      !current ||
      current.attemptId !== attemptId ||
      (current.status !== "QUEUED" && current.status !== "RUNNING")
    ) {
      return;
    }

    if (existingJob) await queue.remove(jobId).catch(() => {});
  }

  await queue.add(
    "slice",
    {
      sliceResultId,
      attemptId,
      modelId: model.id,
      fileHash: model.fileHash,
      settingsKey: key,
      settings,
    },
    { jobId },
  );
}
