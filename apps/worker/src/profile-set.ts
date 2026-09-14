import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@print/db";
import {
  CUSTOM_FILAMENT_SLOTS,
  applyActiveProfiles,
  cleanProfile,
  isProfileSlot,
  profileRevision,
  slotFileName,
  slotInScope,
  slotKind,
  type OrcaProfile,
  type PrinterProfileSpec,
  type ProfileSlot,
} from "@print/shared";
import { BASE_PROFILE_SET, MACHINE_PROFILE, config, printerSpec, type ProfileSet } from "./config.js";

export interface SetUpload {
  id: string;
  slot: ProfileSlot;
  /** The resolved preset; cleaned and bound to the machine when written. */
  flattened: OrcaProfile;
  meta: unknown;
}

export const profileSetsRoot = () => join(config.workRoot, "profile-sets");
const OLD_SET_GRACE_MS = 60 * 60 * 1000;

/** Live uploads that apply on this install: every slot in advanced mode, the
 *  shop's own materials' filament slots otherwise (slotInScope). Anything else
 *  — say, rows left from an install that was in advanced mode — is ignored. */
function liveWhere() {
  return config.advancedProfiles
    ? { status: "ACTIVE" as const }
    : { status: "ACTIVE" as const, slot: { in: [...CUSTOM_FILAMENT_SLOTS] } };
}

/** The build volume models are packed onto and judged against: the owner's
 *  uploaded printer in advanced mode, the installer's otherwise. Outside
 *  advanced mode only filament presets can be live, and those never change the
 *  build volume, so no query is needed. */
export async function activeBedMm(): Promise<PrinterProfileSpec["bedMm"]> {
  if (!config.advancedProfiles) return printerSpec.bedMm;
  const rows = await prisma.slicerProfileUpload.findMany({
    where: liveWhere(),
    select: { id: true, slot: true, meta: true },
  });
  const live = rows.filter((r) => r.slot && slotInScope(r.slot, true));
  return applyActiveProfiles(printerSpec, live.map((r) => ({ ...r, slot: r.slot! }))).bedMm;
}

/** The set slices use right now: the base set, or — once the owner has live
 *  uploads — the base with those presets swapped in, written once per revision
 *  to a slicer-readable directory under the work root. */
export async function activeProfileSet(): Promise<ProfileSet> {
  const ids = await prisma.slicerProfileUpload.findMany({
    where: liveWhere(),
    select: { id: true, slot: true },
  });
  const live = ids.filter((r) => isProfileSlot(r.slot) && slotInScope(r.slot, config.advancedProfiles));
  if (live.length === 0) return BASE_PROFILE_SET;
  const dir = join(profileSetsRoot(), `r-${profileRevision(live.map((r) => r.id))}`);
  // Written already: only the small metadata is needed to describe it.
  if (await exists(dir)) {
    const rows = await prisma.slicerProfileUpload.findMany({
      where: { id: { in: live.map((r) => r.id) } },
      select: { id: true, slot: true, meta: true },
    });
    return describeSet(dir, rows.map((r) => ({ ...r, slot: r.slot as ProfileSlot })));
  }
  const rows = await prisma.slicerProfileUpload.findMany({
    where: { id: { in: live.map((r) => r.id) } },
    select: { id: true, slot: true, meta: true, flattened: true },
  });
  const set = await materialiseProfileSet(
    rows.map((r) => ({ id: r.id, slot: r.slot as ProfileSlot, meta: r.meta, flattened: (r.flattened ?? {}) as OrcaProfile })),
    dir,
  );
  await pruneOldSets(dir);
  return set;
}

function describeSet(dir: string, uploads: readonly { id: string; slot: ProfileSlot; meta: unknown }[]): ProfileSet {
  return { dir, machineFile: MACHINE_PROFILE, spec: applyActiveProfiles(printerSpec, uploads) };
}

/** Write the base set with `uploads` swapped in to `dir` (atomically: a set
 *  directory that exists is complete). Readable by the slicer identities:
 *  0711 down to the set, 0755 on it, 0644 files. */
export async function materialiseProfileSet(uploads: readonly SetUpload[], dir: string): Promise<ProfileSet> {
  await mkdir(config.workRoot, { recursive: true, mode: 0o711 });
  await mkdir(profileSetsRoot(), { recursive: true, mode: 0o711 });
  await chmod(profileSetsRoot(), 0o711);
  const tmp = `${dir}.tmp-${randomUUID()}`;
  await mkdir(tmp, { mode: 0o755 });
  try {
    for (const name of await readdir(config.profilesDir)) {
      if (name.endsWith(".json") && name !== "printer.json") await copyFile(join(config.profilesDir, name), join(tmp, name));
    }
    // Uploads bind to the base machine's name, so the base presets they don't
    // replace — which name it in compatible_printers — stay loadable with them.
    const base = JSON.parse(await readFile(join(config.profilesDir, MACHINE_PROFILE), "utf8")) as OrcaProfile;
    const machineName = String(base.name ?? printerSpec.machine);
    for (const upload of uploads) {
      const kind = slotKind(upload.slot);
      const name = kind === "machine" ? machineName : String(upload.flattened.name ?? upload.slot);
      await writeFile(
        join(tmp, slotFileName(upload.slot, MACHINE_PROFILE)),
        JSON.stringify(cleanProfile(upload.flattened, kind, name, machineName)),
      );
    }
    const set = describeSet(dir, uploads);
    await writeFile(join(tmp, "printer.json"), JSON.stringify(set.spec, null, 2));
    for (const name of await readdir(tmp)) await chmod(join(tmp, name), 0o644);
    await chmod(tmp, 0o755);
    try {
      await rename(tmp, dir);
    } catch (error) {
      // Another job wrote the same revision first; theirs is identical.
      if (!(await exists(dir))) throw error;
      await rm(tmp, { recursive: true, force: true });
    }
    return set;
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

/** Drop earlier revisions once nothing can still be slicing with them. */
async function pruneOldSets(current: string): Promise<void> {
  const root = profileSetsRoot();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, name);
    if (path === current || !name.startsWith("r-")) continue;
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > OLD_SET_GRACE_MS) await rm(path, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
