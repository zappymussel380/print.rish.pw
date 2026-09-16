import { NextResponse, type NextRequest } from "next/server";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { BackupRejected, buildBackup, restoreBackup } from "@/lib/settings-backup";
import { getSiteProfile } from "@/lib/site-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Presets make a backup bigger than a settings form; docker/proxy/nginx.conf
 *  allows this path a little more, so an oversized file gets this app's error. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// The shop's day (India), as the restore step shows the file's date.
const fileDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });

/** Admin: download every saved setting and the live slicer presets. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  const [backup, profile] = await Promise.all([buildBackup(), getSiteProfile()]);
  const slug = profile.brandName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shop";
  return new NextResponse(JSON.stringify(backup, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-settings-${fileDate.format(new Date(backup.exportedAt))}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Admin: restore a downloaded backup over this install's settings. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(await restoreBackup(body.value));
  } catch (error) {
    if (error instanceof BackupRejected) return jsonError(422, "BAD_BACKUP", error.message);
    throw error;
  }
}
