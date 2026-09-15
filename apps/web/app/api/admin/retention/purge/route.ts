import { NextResponse, type NextRequest } from "next/server";
import { purgeInputSchema } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { getMaintenanceQueue } from "@/lib/queue";
import { purgePreview } from "@/lib/retention-settings";
import { assertSameOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PURGE_JOB_ID = "purge";

/** Admin: how many uploads and finished quotations' files a purge of
 *  everything older than ?olderThanDays would remove. */
export async function GET(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  const parsed = purgeInputSchema.safeParse({ olderThanDays: Number(request.nextUrl.searchParams.get("olderThanDays")) });
  if (!parsed.success) return jsonError(422, "BAD_DAYS", "Pick 1 to 3650 days.");
  return NextResponse.json(await purgePreview(parsed.data.olderThanDays));
}

/** Admin: purge now. The worker deletes uploads never quoted and the files of
 *  finished quotations older than the days given; quotation records, their
 *  PDFs and anything still open are never touched. One purge at a time. */
export async function POST(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const body = await readJsonBody(request, 256);
  if (!body.ok) return body.response;
  const parsed = purgeInputSchema.safeParse(body.value);
  if (!parsed.success) return jsonError(422, "BAD_DAYS", "Pick 1 to 3650 days.");
  try {
    const queue = getMaintenanceQueue();
    // The fixed job id keeps it to one purge at a time, but BullMQ silently
    // ignores an add whose id still exists — and a failed purge is kept for
    // inspection. Clear a finished one first, or every later purge is a no-op.
    const previous = await queue.getJob(PURGE_JOB_ID);
    if (previous) {
      const state = await previous.getState();
      if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(state)) {
        return jsonError(409, "PURGE_RUNNING", "A purge is already running. Check again in a minute.");
      }
      await previous.remove();
    }
    await queue.add("purge", { kind: "purge", olderThanDays: parsed.data.olderThanDays }, { jobId: PURGE_JOB_ID });
  } catch {
    return jsonError(503, "QUEUE_UNAVAILABLE", "The worker's queue isn't reachable. Try again in a minute.");
  }
  return NextResponse.json({ queued: true }, { status: 202 });
}
