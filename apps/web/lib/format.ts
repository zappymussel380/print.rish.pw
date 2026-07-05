import type { BoundingBoxMm } from "@print/shared";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** e.g. "62.4 × 40.0 × 18.2 mm" */
export function formatDimensions(bbox: BoundingBoxMm): string {
  const d = (n: number) => n.toFixed(1);
  return `${d(bbox.x)} × ${d(bbox.y)} × ${d(bbox.z)} mm`;
}

export function formatVolume(cm3: number): string {
  return `${cm3.toFixed(cm3 < 10 ? 2 : 1)} cm³`;
}
