import { Prisma, prisma } from "@print/db";

export interface SliceAttemptIdentity {
  id: string;
  attemptId: string;
  fileHash: string;
  settingsKey: string;
}

/** Claim a queued attempt, or resume the same attempt after BullMQ retries a
 * worker crash. A terminal row or a newer retry generation is never reopened. */
export async function claimSliceAttempt(
  identity: SliceAttemptIdentity,
  data: Prisma.SliceResultUpdateManyMutationInput,
): Promise<boolean> {
  const result = await prisma.sliceResult.updateMany({
    where: {
      ...identity,
      status: { in: ["QUEUED", "RUNNING"] },
    },
    data,
  });
  return result.count === 1;
}

/** Persist progress or a processor result only while this exact attempt owns
 * RUNNING. This is the database half of the retry-generation fence. */
export async function updateRunningSliceAttempt(
  identity: SliceAttemptIdentity,
  data: Prisma.SliceResultUpdateManyMutationInput,
): Promise<boolean> {
  const result = await prisma.sliceResult.updateMany({
    where: { ...identity, status: "RUNNING" },
    data,
  });
  return result.count === 1;
}

/** BullMQ emits `failed` after processor exceptions. Fence that asynchronous
 * event so it cannot turn DONE, FAILED, or a newer retry generation into a
 * failure belonging to an older job. */
export async function failLiveSliceAttempt(
  identity: SliceAttemptIdentity,
  data: Prisma.SliceResultUpdateManyMutationInput,
): Promise<boolean> {
  const result = await prisma.sliceResult.updateMany({
    where: {
      ...identity,
      status: { in: ["QUEUED", "RUNNING"] },
    },
    data,
  });
  return result.count === 1;
}
