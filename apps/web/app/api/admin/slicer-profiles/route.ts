import { NextResponse, type NextRequest } from "next/server";
import { isProfileSlot, sanitizeOriginalName, slotInScope } from "@print/shared";
import { jsonError, readBinaryBody, requireAdminApi } from "@/lib/api-util";
import { advancedProfilesEnabled } from "@/lib/printer";
import { assertSameOrigin } from "@/lib/security";
import { MAX_PROFILE_UPLOAD_BYTES, ProfileUploadRejected, parseProfileUpload } from "@/lib/slicer-profile-upload";
import { getSlicerProfilesState, queueProfileUpload, revertToInstalled } from "@/lib/slicer-profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard(request: NextRequest | null): Promise<NextResponse | null> {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (request && !assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  return null;
}

/** Every slot in advanced mode; the shop's own materials' filament slots on
 *  any install. A bundle (no slot) is a whole printer: advanced mode only. */
function slotRefused(slot: string | null): NextResponse | null {
  const advanced = advancedProfilesEnabled();
  if (slot === null ? advanced : slotInScope(slot, advanced)) return null;
  return jsonError(
    403,
    "SLOT_NOT_OPEN",
    "On this install only your own materials take uploaded presets; the printer and the other materials use the profiles the installer set up.",
  );
}

/** Admin: every open slot's live preset, and recent uploads with their test results. */
export async function GET() {
  const denied = await guard(null);
  if (denied) return denied;
  return NextResponse.json(await getSlicerProfilesState());
}

/** Admin: upload one OrcaSlicer preset (.json, for `?slot=`) or a bundle
 *  (.orca_printer / .orca_filament) as the raw body. Nothing goes live until
 *  the worker's test slice passes. */
export async function POST(request: NextRequest) {
  const denied = await guard(request);
  if (denied) return denied;

  const slotParam = request.nextUrl.searchParams.get("slot") || null;
  if (slotParam !== null && !isProfileSlot(slotParam)) return jsonError(422, "BAD_SLOT", "Unknown profile slot.");
  const refused = slotRefused(slotParam);
  if (refused) return refused;
  const fileName = sanitizeOriginalName(request.nextUrl.searchParams.get("name") || "preset.json");

  const body = await readBinaryBody(request, MAX_PROFILE_UPLOAD_BYTES);
  if (!body.ok) return body.response;

  let upload;
  try {
    upload = parseProfileUpload(body.value, fileName, slotParam);
  } catch (error) {
    if (error instanceof ProfileUploadRejected) return jsonError(422, "BAD_PROFILE", error.message);
    throw error;
  }
  // What the file unpacked to must fit too: a printer bundle sent to one of the
  // shop's own materials is still a printer.
  if (upload.presets.some((p) => slotRefused(p.slot))) {
    return jsonError(422, "BAD_PROFILE", "That file isn't a single filament preset. Export just the filament from OrcaSlicer.");
  }
  try {
    await queueProfileUpload(upload, fileName);
  } catch {
    return jsonError(503, "QUEUE_UNAVAILABLE", "The test slice couldn't be queued. Try again in a minute.");
  }
  return NextResponse.json({ ...(await getSlicerProfilesState()), ignored: upload.ignored }, { status: 202 });
}

/** Admin: put `?slot=` back on the installed preset. */
export async function DELETE(request: NextRequest) {
  const denied = await guard(request);
  if (denied) return denied;
  const slot = request.nextUrl.searchParams.get("slot") ?? "";
  if (!isProfileSlot(slot)) return jsonError(422, "BAD_SLOT", "Unknown profile slot.");
  const refused = slotRefused(slot);
  if (refused) return refused;
  if (!(await revertToInstalled(slot))) return jsonError(422, "BAD_SLOT", "Unknown profile slot.");
  return NextResponse.json(await getSlicerProfilesState());
}
