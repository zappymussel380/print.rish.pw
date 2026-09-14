import { randomUUID } from "node:crypto";
import { Prisma, prisma } from "@print/db";
import {
  PROFILE_SLOTS,
  isProfileSlot,
  materialName,
  slicerProfileJobId,
  slotInScope,
  slotLayerUm,
  slotMaterial,
  type CustomMaterialNames,
  type ProfileSlot,
} from "@print/shared";
import { getStoredCatalogAvailability } from "./catalog-availability";
import { advancedProfilesEnabled, getPrinterProfile, getPrinterSpec } from "./printer";
import { getSlicerProfileQueue } from "./queue";
import type { ParsedUpload } from "./slicer-profile-upload";

/** What the admin shows per preset slot: every slot in advanced mode (the
 *  Slicer profiles section), the shop's own materials' filament slots on any
 *  install (Your own materials). */
export interface SlicerProfileSlotState {
  slot: ProfileSlot;
  label: string;
  /** The live upload, or null while the slot uses the installed preset. */
  live: { presetName: string; originalName: string; testGrams: number | null; checkedAt: string | null } | null;
  testing: boolean;
  /** Why the latest upload for this slot didn't go live, when it's newer than
   *  what is live. */
  lastError: string | null;
}

export interface SlicerProfileUploadState {
  batchId: string;
  originalName: string;
  createdAt: string;
  status: "testing" | "failed" | "live" | "replaced";
  error: string | null;
  presets: { presetName: string; slot: string | null; status: string; note: string | null }[];
}

export interface SlicerProfilesState {
  printer: { name: string; machine: string; bedMm: [number, number, number]; nozzleMm: number };
  slots: SlicerProfileSlotState[];
  uploads: SlicerProfileUploadState[];
  busy: boolean;
}

export function slotTitle(slot: ProfileSlot, names?: CustomMaterialNames): string {
  const um = slotLayerUm(slot);
  if (um) return `Process · ${(um / 1000).toFixed(2)} mm layers`;
  const material = slotMaterial(slot);
  if (material) return `Filament · ${materialName(material, names)}`;
  return "Printer";
}

const RECENT_BATCHES = 8;

export async function getSlicerProfilesState(): Promise<SlicerProfilesState> {
  const advanced = advancedProfilesEnabled();
  const [printer, { customMaterials }, rows] = await Promise.all([
    getPrinterProfile(),
    getStoredCatalogAvailability(),
    prisma.slicerProfileUpload.findMany({
      where: { status: { not: "RETIRED" } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        batchId: true,
        slot: true,
        originalName: true,
        presetName: true,
        status: true,
        error: true,
        testGrams: true,
        createdAt: true,
        checkedAt: true,
      },
    }),
  ]);
  // Retired rows only matter for describing recent uploads that were replaced.
  const batchIds = [...new Set(rows.map((r) => r.batchId))].slice(0, RECENT_BATCHES);
  const batchRows = await prisma.slicerProfileUpload.findMany({
    where: { batchId: { in: batchIds } },
    orderBy: { createdAt: "asc" },
    select: { batchId: true, slot: true, originalName: true, presetName: true, status: true, error: true, createdAt: true },
  });

  const slots = PROFILE_SLOTS.filter((slot) => slotInScope(slot, advanced)).map((slot): SlicerProfileSlotState => {
    const live = rows.find((r) => r.slot === slot && r.status === "ACTIVE");
    // Rows come newest first: the latest attempt, if it failed after what's live.
    const latest = rows.find((r) => r.slot === slot && r.status !== "SKIPPED");
    const failedLater = latest?.status === "FAILED" && (!live || latest.createdAt > live.createdAt);
    return {
      slot,
      label: slotTitle(slot, customMaterials),
      lastError: failedLater ? latest.error : null,
      live: live
        ? {
            presetName: live.presetName,
            originalName: live.originalName,
            testGrams: live.testGrams,
            checkedAt: live.checkedAt?.toISOString() ?? null,
          }
        : null,
      testing: rows.some((r) => r.slot === slot && (r.status === "PENDING" || r.status === "TESTING")),
    };
  });

  const uploads = batchIds.map((batchId): SlicerProfileUploadState => {
    const presets = batchRows.filter((r) => r.batchId === batchId);
    const first = presets[0]!;
    const statuses = new Set(presets.map((p) => p.status));
    const status =
      statuses.has("PENDING") || statuses.has("TESTING")
        ? "testing"
        : statuses.has("FAILED")
          ? "failed"
          : statuses.has("ACTIVE")
            ? "live"
            : "replaced";
    return {
      batchId,
      originalName: first.originalName,
      createdAt: first.createdAt.toISOString(),
      status,
      error: presets.find((p) => p.status === "FAILED")?.error ?? null,
      presets: presets.map((p) => ({
        presetName: p.presetName,
        slot: p.slot,
        status: p.status,
        note: p.status === "SKIPPED" ? p.error : null,
      })),
    };
  });

  return {
    printer: { name: getPrinterSpec().name, machine: printer.machine, bedMm: printer.bedMm, nozzleMm: printer.nozzleMm },
    slots,
    uploads,
    busy: uploads.some((u) => u.status === "testing"),
  };
}

/** Store an upload as one batch and queue its test slice. */
export async function queueProfileUpload(upload: ParsedUpload, originalName: string): Promise<void> {
  const batchId = randomUUID();
  await prisma.slicerProfileUpload.createMany({
    data: upload.presets.map((preset) => ({
      id: randomUUID(),
      batchId,
      slot: preset.slot,
      originalName,
      presetName: preset.name,
      raw: preset.raw as Prisma.InputJsonObject,
      status: "PENDING" as const,
    })),
  });
  try {
    await getSlicerProfileQueue().add("test", { batchId }, { jobId: slicerProfileJobId(batchId) });
  } catch (error) {
    await prisma.slicerProfileUpload.updateMany({
      where: { batchId },
      data: { status: "FAILED", error: "The test slice couldn't be queued. Try again in a minute.", checkedAt: new Date() },
    });
    throw error;
  }
}

/** Put a slot back on the installed preset. */
export async function revertToInstalled(slot: string): Promise<boolean> {
  if (!isProfileSlot(slot)) return false;
  await prisma.slicerProfileUpload.updateMany({
    where: { slot, status: "ACTIVE" },
    data: { status: "RETIRED", checkedAt: new Date() },
  });
  return true;
}
