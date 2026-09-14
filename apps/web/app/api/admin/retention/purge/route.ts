import { NextResponse, type NextRequest } from "next/server";
import { purgeInputSchema } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { getMaintenanceQueue } from "@/lib/queue";
import { purgePreview } from "@/lib/retention-settings";
import { assertSameOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    await getMaintenanceQueue().add("purge", { kind: "purge", olderThanDays: parsed.data.olderThanDays }, { jobId: "purge" });
  } catch {
    return jsonError(503, "QUEUE_UNAVAILABLE", "The worker's queue isn't reachable. Try again in a minute.");
  }
  return NextResponse.json({ queued: true }, { status: 202 });
}
