import { NextResponse, type NextRequest } from "next/server";
import { Prisma, prisma } from "@print/db";
import {
  type SliceJobData,
  settingsKey,
  sliceJobId,
  sliceSettingsSchema,
} from "@print/shared";
import { assertBodySize, guardMutation, jsonError } from "@/lib/api-util";
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
  const tooLarge = assertBodySize(request, 4 * 1024);
  if (tooLarge) return tooLarge;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError(400, "BAD_JSON", "Request body must be JSON");
  }

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

  const key = settingsKey(settings);

  const existing = await prisma.sliceResult.findUnique({
    where: { fileHash_settingsKey: { fileHash: model.fileHash, settingsKey: key } },
  });
  if (existing) {
    // A previously failed slice is retried on explicit re-request.
    if (existing.status !== "FAILED") {
      if (existing.status === "QUEUED" || existing.status === "RUNNING") {
        await enqueue(existing.id, model, key, settings, { ensureLiveJob: true });
      }
      return NextResponse.json(serializeSlice(existing));
    }
    await prisma.sliceResult.update({
      where: { id: existing.id },
      data: { status: "QUEUED", errorCode: null, errorMessage: null, completedAt: null },
    });
    await enqueue(existing.id, model, key, settings, { replaceExistingJob: true });
    return NextResponse.json(
      serializeSlice({ ...existing, status: "QUEUED", errorCode: null, errorMessage: null }),
      { status: 202 },
    );
  }

  // Cache miss — create the row, tolerating a concurrent creator via the
  // (fileHash, settingsKey) unique constraint.
  let row;
  try {
    row = await prisma.sliceResult.create({
      data: {
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
      if (winner) return NextResponse.json(serializeSlice(winner));
    }
    throw err;
  }

  await enqueue(row.id, model, key, settings);
  return NextResponse.json(serializeSlice(row), { status: 202 });
}

async function enqueue(
  sliceResultId: string,
  model: { id: string; fileHash: string; storedPath: string; format: string },
  key: string,
  settings: SliceJobData["settings"],
  options: { replaceExistingJob?: boolean; ensureLiveJob?: boolean } = {},
) {
  const queue = getSliceQueue();
  const jobId = sliceJobId(model.fileHash, key);

  if (options.replaceExistingJob) {
    await queue.remove(jobId).catch(() => {});
  } else if (options.ensureLiveJob) {
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (["active", "delayed", "prioritized", "waiting", "waiting-children"].includes(state)) {
        return;
      }
      await queue.remove(jobId).catch(() => {});
    }
  }

  await queue.add(
    "slice",
    {
      sliceResultId,
      modelId: model.id,
      fileHash: model.fileHash,
      settingsKey: key,
      storedPath: model.storedPath,
      format: model.format,
      settings,
    },
    { jobId },
  );
}
