"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ImagePlus, Loader2, Trash2 } from "lucide-react";
import {
  MATERIAL_IDS,
  MAX_CAPTION_LENGTH,
  MAX_SHOWCASE_PHOTO_BYTES,
  type RecentPrint,
} from "@print/shared";

const ACCEPT = "image/jpeg,image/png";

/** An entry plus the things only the editor knows about it.
 *
 * `previewUrl` is a local object URL for a photo uploaded in this session. It
 * matters because `/api/showcase/:id/photo` deliberately serves only ids that
 * are already in the published list — that is what stops an arbitrary UUID
 * probing storage — so a just-uploaded photo has no server URL yet and would
 * render as a broken image. `saved` drives the unsaved marker. */
type EditorPrint = RecentPrint & { previewUrl?: string; saved?: boolean };
const MAX_PHOTO_MB = Math.round(MAX_SHOWCASE_PHOTO_BYTES / 1024 / 1024);

/**
 * Admin editor for the public "Recent prints" showcase.
 *
 * Uploading and describing are two steps on purpose: the photo is POSTed on
 * its own and comes back with the id that addresses it on disk, then the whole
 * ordered list — captions, materials, order — is PUT as one payload. That
 * keeps ordering and deletion a single atomic write, the same way the catalog
 * editor works, and means a photo is never half-described.
 */
export function ShowcaseEditor({ prints }: { prints: RecentPrint[] }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<EditorPrint[]>(
    prints.map((print) => ({ ...print, saved: true })),
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"idle" | "uploading" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Object URLs are a document-lifetime resource; hold them so they can be
  // released when the editor goes away rather than leaking per upload.
  const objectUrls = useRef<string[]>([]);

  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const mutate = (fn: (draft: EditorPrint[]) => EditorPrint[]) => {
    setItems((prev) => fn([...prev]));
    setDirty(true);
  };

  const move = (index: number, delta: number) =>
    mutate((draft) => {
      const target = index + delta;
      if (target < 0 || target >= draft.length) return draft;
      const [entry] = draft.splice(index, 1);
      draft.splice(target, 0, entry!);
      return draft;
    });

  /** Upload one photo. Returns an error string, or null on success. */
  const uploadOne = async (file: File): Promise<string | null> => {
    // Check the size here as well as server-side: it costs nothing, and it
    // turns "upload failed after a long wait" into an instant, specific answer.
    if (file.size > MAX_SHOWCASE_PHOTO_BYTES) {
      return `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_PHOTO_MB} MB.`;
    }
    try {
      const res = await fetch("/api/admin/showcase", {
        method: "POST",
        headers: { "Content-Type": file.type, "X-Requested-With": "XMLHttpRequest" },
        body: file,
      });
      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        photoExt?: RecentPrint["photoExt"];
        error?: { message?: string };
      };
      // Bound before the guard: narrowing on `data.*` does not survive into
      // the mutate callback, which TypeScript treats as deferred.
      const { id, photoExt } = data;
      if (!res.ok || !id || !photoExt) {
        // A rejection can come from the proxy rather than the app, in which
        // case the body is HTML and there is no JSON message to show. Never
        // fall back to a bare "failed" — that is unactionable, and it is what
        // made the 413 at the edge so hard to place.
        return (
          data.error?.message ??
          (res.status === 413
            ? `${file.name} was rejected as too large. The limit is ${MAX_PHOTO_MB} MB.`
            : `${file.name} failed to upload (HTTP ${res.status}).`)
        );
      }
      // Preview from the file the browser already has: instant, and correct
      // before the entry exists server-side.
      const previewUrl = URL.createObjectURL(file);
      objectUrls.current.push(previewUrl);
      mutate((draft) => [
        {
          id,
          previewUrl,
          saved: false,
          caption: file.name
            .replace(/\.[^.]+$/, "")
            .replace(/[-_]+/g, " ")
            .slice(0, MAX_CAPTION_LENGTH),
          material: "PLA",
          photoExt,
          createdAt: new Date().toISOString(),
        },
        ...draft,
      ]);
      return null;
    } catch {
      return `${file.name} could not be sent — check the connection.`;
    }
  };

  /** Upload a picked or dropped selection, one at a time.
   *
   * Sequential rather than parallel: each upload writes a file and the admin
   * is one person on one connection, so concurrency buys nothing and makes a
   * partial failure harder to report. */
  const acceptFiles = useCallback(async (files: FileList | File[]) => {
    const chosen = Array.from(files).filter((f) => f.size > 0);
    if (chosen.length === 0) return;

    setBusy("uploading");
    setError(null);
    const problems: string[] = [];
    try {
      for (const file of chosen) {
        const problem = await uploadOne(file);
        if (problem) problems.push(problem);
      }
    } finally {
      setBusy("idle");
      if (fileInput.current) fileInput.current.value = "";
    }
    // Report every failure, not just the first: dropping ten photos and being
    // told about one of them is worse than being told about none.
    if (problems.length) setError(problems.join(" "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setBusy("saving");
    setError(null);
    try {
      const res = await fetch("/api/admin/showcase", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        // Send only the stored shape. Zod would drop the editor-only fields
        // anyway; being explicit keeps the payload honest.
        body: JSON.stringify({
          prints: items.map(({ id, caption, material, colour, photoExt, createdAt }) => ({
            id,
            caption,
            material,
            colour,
            photoExt,
            createdAt,
          })),
        }),
      });
      if (!res.ok) {
        setError("Saving the showcase failed.");
        return;
      }
      const data = (await res.json()) as { prints: RecentPrint[] };
      // Take the server's normalized list back: an entry it rejected (an empty
      // caption, say) must disappear here too rather than look saved. Keep the
      // local previews — their ids now resolve server-side, but the object URL
      // is already decoded and avoids a refetch.
      setItems(
        data.prints.map((print) => {
          const previous = items.find((item) => item.id === print.id);
          return {
            ...print,
            saved: true,
            ...(previous?.previewUrl ? { previewUrl: previous.previewUrl } : {}),
          };
        }),
      );
      setDirty(false);
      router.refresh();
    } finally {
      setBusy("idle");
    }
  };

  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Recent prints · public showcase</span>
        <span className="text-faint">{items.length} shown</span>
      </summary>

      <div className="space-y-4 border-t border-line p-4">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          id="showcase-photo"
          onChange={(e) => {
            if (e.target.files?.length) void acceptFiles(e.target.files);
          }}
        />
        {/* Drop target. Also click- and keyboard-operable, so dragging is an
            addition rather than the only way in — same contract as the
            customer-facing model dropzone. */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Add showcase photos"
          aria-disabled={busy !== "idle"}
          onClick={() => busy === "idle" && fileInput.current?.click()}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && busy === "idle") {
              e.preventDefault();
              fileInput.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (busy === "idle") setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) void acceptFiles(e.dataTransfer.files);
          }}
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-6 py-8 text-center transition-colors"
          style={{
            borderColor: dragging ? "var(--accent)" : undefined,
            background: dragging ? "color-mix(in srgb, var(--accent) 8%, transparent)" : undefined,
          }}
        >
          {busy === "uploading" ? (
            <>
              <Loader2 strokeWidth={2} className="size-5 animate-spin text-accent" />
              <p className="text-sm font-[650]">Uploading&hellip;</p>
            </>
          ) : (
            <>
              <ImagePlus strokeWidth={1.65} className="size-5 text-accent" aria-hidden="true" />
              <p className="text-sm font-[650]">
                {dragging ? "Drop to add" : "Drop photos here, or click to choose"}
              </p>
            </>
          )}
          <p className="text-xs text-faint">
            JPEG or PNG, up to {MAX_PHOTO_MB}&nbsp;MB each. Several at once is fine. Location
            and camera data are stripped on upload.
          </p>
        </div>

        {error && (
          <p className="text-xs text-accent" role="alert">
            {error}
          </p>
        )}

        {items.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing published yet. Add a photo to start the homepage showcase.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((item, index) => (
              <li key={item.id} className="flex flex-wrap items-start gap-3 border-t border-line pt-3 first:border-t-0 first:pt-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.previewUrl ?? `/api/showcase/${item.id}/photo`}
                  alt={item.caption ? `Preview of ${item.caption}` : "Uploaded photo"}
                  width={72}
                  height={72}
                  className="size-[72px] shrink-0 rounded-lg border border-line object-cover"
                />
                <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                  <label className="min-w-[12rem] flex-1">
                    <span className="sr-only">Caption</span>
                    <input
                      value={item.caption}
                      maxLength={MAX_CAPTION_LENGTH}
                      placeholder="What is it?"
                      className="input-base w-full text-sm"
                      onChange={(e) =>
                        mutate((draft) => {
                          draft[index] = { ...draft[index]!, caption: e.target.value };
                          return draft;
                        })
                      }
                    />
                  </label>
                  <label>
                    <span className="sr-only">Material</span>
                    <select
                      value={item.material}
                      className="input-base text-sm"
                      onChange={(e) =>
                        mutate((draft) => {
                          draft[index] = {
                            ...draft[index]!,
                            material: e.target.value as RecentPrint["material"],
                          };
                          return draft;
                        })
                      }
                    >
                      {MATERIAL_IDS.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="w-[9rem]">
                    <span className="sr-only">Colour</span>
                    <input
                      value={item.colour ?? ""}
                      maxLength={MAX_CAPTION_LENGTH}
                      placeholder="Colour"
                      className="input-base w-full text-sm"
                      onChange={(e) =>
                        mutate((draft) => {
                          draft[index] = { ...draft[index]!, colour: e.target.value };
                          return draft;
                        })
                      }
                    />
                  </label>
                </div>
                {item.saved === false && (
                  <span className="chip chip-accent self-center" title="Not saved yet — click Save showcase">
                    Unsaved
                  </span>
                )}
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp strokeWidth={1.65} className="size-4" />
                  </IconButton>
                  <IconButton
                    label="Move down"
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown strokeWidth={1.65} className="size-4" />
                  </IconButton>
                  <IconButton
                    label={`Remove ${item.caption || "photo"}`}
                    onClick={() => mutate((draft) => draft.filter((_, i) => i !== index))}
                  >
                    <Trash2 strokeWidth={1.65} className="size-4" />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3 border-t border-line pt-4">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || busy !== "idle"}
            className="btn-pill text-sm"
          >
            {busy === "saving" ? (
              <>
                <Loader2 strokeWidth={2} className="size-4 animate-spin" /> Saving…
              </>
            ) : (
              "Save showcase"
            )}
          </button>
          {dirty && <span className="text-xs text-muted">Unsaved changes</span>}
        </div>
      </div>
    </details>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-full text-faint transition-colors hover:text-accent disabled:opacity-30"
    >
      {children}
    </button>
  );
}
