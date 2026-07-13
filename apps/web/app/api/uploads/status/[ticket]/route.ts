import { NextResponse, type NextRequest } from "next/server";
import {
  UUID_RE,
  ingestJobDataSchema,
  ingestJobResultSchema,
  publicIngestFailure,
  type UploadTicketDto,
} from "@print/shared";
import { jsonError } from "@/lib/api-util";
import { getIngestCountAhead } from "@/lib/ingest-queue";
import { getIngestQueue } from "@/lib/queue";
import { redis } from "@/lib/redis";
import { clientIp, rateLimit, RATE_LIMITS } from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unknownTicket() {
  return jsonError(404, "NOT_FOUND", "Unknown upload ticket");
}

function unavailable() {
  return jsonError(
    503,
    "INGEST_UNAVAILABLE",
    "Model processing status is temporarily unavailable. Please retry shortly.",
  );
}

/** Poll one unguessable ingest ticket. Job data is still treated as
 * Redis-controlled input: validate it before using the session ownership field
 * and never return paths, hashes, failure reasons, or other internal fields. */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ ticket: string }> },
) {
  const { ticket } = await ctx.params;
  if (!UUID_RE.test(ticket)) return unknownTicket();

  try {
    const sessionId = await getQuoteSessionId();
    if (!sessionId) return unknownTicket();

    const limit = await rateLimit(
      "uploadPoll",
      `${clientIp(request)}:${sessionId}`,
      RATE_LIMITS.uploadPoll.max,
      RATE_LIMITS.uploadPoll.windowSeconds,
    );
    if (!limit.allowed) {
      const response = jsonError(429, "RATE_LIMITED", "Too many polling requests");
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }

    const queue = getIngestQueue();
    const job = await queue.getJob(ticket);
    if (!job) return unknownTicket();
    const data = ingestJobDataSchema.safeParse(job.data);
    if (!data.success || data.data.sessionId !== sessionId) return unknownTicket();

    // A job can cross waiting → active → completed between calls. Retry the
    // snapshot once when a waiting job is absent from the FIFO range instead of
    // inventing a position or leaking an inconsistent internal state.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await job.getState();
      if (state === "waiting") {
        const position = await getIngestCountAhead(queue, ticket);
        if (position === null) continue;
        const response: UploadTicketDto = {
          status: "queued",
          position,
          processorOnline: (await redis.exists("worker:heartbeat")) === 1,
        };
        return NextResponse.json(response);
      }
      if (state === "active") {
        const response: UploadTicketDto = { status: "processing" };
        return NextResponse.json(response);
      }
      if (state === "completed") {
        const result = ingestJobResultSchema.safeParse(job.returnvalue);
        const response: UploadTicketDto = result.success
          ? { status: "done", ...result.data }
          : {
              status: "failed",
              error: publicIngestFailure(
                "INGEST_FAILED",
                "The model could not be processed. Please upload it again.",
              ),
            };
        return NextResponse.json(response);
      }
      if (state === "failed") {
        const response: UploadTicketDto = {
          status: "failed",
          error:
            data.data.publicFailure ??
            publicIngestFailure(
              "INGEST_FAILED",
              "The model could not be processed. Please upload it again.",
            ),
        };
        return NextResponse.json(response);
      }
      if (state === "unknown") return unknownTicket();
      // Ingest jobs never use delays, priorities, or dependencies. Treat a
      // transient unexpected state like a transition and retry once.
    }
    return unavailable();
  } catch {
    return unavailable();
  }
}
