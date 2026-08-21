import { z } from "zod";
import { MATERIAL_IDS, type MaterialId } from "./quote-types";

/**
 * The admin-curated "recent prints" showcase: a short, ordered list of photos
 * of real prints, so visitors can see what the machine actually produces.
 *
 * Persisted as one JSON app setting rather than its own table. The list is
 * small and wholly admin-authored, and the provisioning allowlist grants
 * privileges per table — a new table is unreadable in production until that
 * allowlist is deliberately updated, which is not a cost this earns.
 *
 * Pure logic only (no DB), so it is testable and safe to reuse on the client.
 */

/** Beyond this the homepage strip and the gallery page stop being a curated
 *  showcase, and the single JSON row stops being a sensible way to store it. */
export const MAX_RECENT_PRINTS = 60;
/** Largest photo the upload route accepts.
 *
 * Shared deliberately: the admin UI, the API route and the proxy's
 * `client_max_body_size` all have to agree about this number, and the proxy
 * silently winning that disagreement is exactly how photo upload shipped
 * broken — every real photo was refused at the edge with no log line. The
 * proxy allowance sits just above this so an oversized file is refused by the
 * application, with an error the UI can actually show. */
export const MAX_SHOWCASE_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_CAPTION_LENGTH = 120;

export type RecentPrintPhotoExt = "jpg" | "png";
export const RECENT_PRINT_PHOTO_EXTS = ["jpg", "png"] as const;

export interface RecentPrint {
  /** UUID; also names the photo on disk as `<id>.<ext>`. */
  id: string;
  caption: string;
  material: MaterialId;
  /** Free-text colour as the admin typed it, e.g. "Matte black". */
  colour?: string;
  photoExt: RecentPrintPhotoExt;
  /** ISO-8601. Ordering is the stored array order, not this. */
  createdAt: string;
}

const uuid = z.string().uuid();

/** Wire shape for a stored or submitted showcase. Deliberately loose;
 *  `normalizeRecentPrints` is the single place that hardens it. */
export const recentPrintsSchema = z.object({
  prints: z
    .array(
      z.object({
        id: z.string(),
        caption: z.string(),
        material: z.string(),
        colour: z.string().optional(),
        photoExt: z.string(),
        createdAt: z.string().optional(),
      }),
    )
    .optional(),
});
export type RecentPrintsInput = z.infer<typeof recentPrintsSchema>;

/** Harden arbitrary/stored input into a valid showcase: drop entries with an
 *  unusable id, material or photo extension, clamp captions, de-duplicate ids,
 *  and cap the list length. Order is preserved — it is the display order. */
export function normalizeRecentPrints(raw: unknown): RecentPrint[] {
  const parsed = recentPrintsSchema.safeParse(raw ?? {});
  if (!parsed.success) return [];

  const materials = new Set<string>(MATERIAL_IDS);
  const exts = new Set<string>(RECENT_PRINT_PHOTO_EXTS);
  const seen = new Set<string>();
  const out: RecentPrint[] = [];

  for (const entry of parsed.data.prints ?? []) {
    if (!uuid.safeParse(entry.id).success || seen.has(entry.id)) continue;
    if (!materials.has(entry.material) || !exts.has(entry.photoExt)) continue;

    const caption = entry.caption.replace(/\s+/g, " ").trim().slice(0, MAX_CAPTION_LENGTH);
    if (!caption) continue;
    const colour = entry.colour?.replace(/\s+/g, " ").trim().slice(0, MAX_CAPTION_LENGTH);

    seen.add(entry.id);
    out.push({
      id: entry.id,
      caption,
      material: entry.material as MaterialId,
      ...(colour ? { colour } : {}),
      photoExt: entry.photoExt as RecentPrintPhotoExt,
      createdAt: isoOrNow(entry.createdAt),
    });
    if (out.length >= MAX_RECENT_PRINTS) break;
  }
  return out;
}

function isoOrNow(value: string | undefined): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

/** Serialisable view for public consumption. Identical today, but it keeps the
 *  public payload an explicit decision rather than "whatever is stored". */
export function toPublicRecentPrints(prints: readonly RecentPrint[]): RecentPrint[] {
  return prints.map((print) => ({ ...print }));
}
