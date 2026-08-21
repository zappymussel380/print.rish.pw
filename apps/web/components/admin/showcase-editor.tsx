"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { MATERIAL_IDS, MAX_CAPTION_LENGTH, type RecentPrint } from "@print/shared";

const ACCEPT = "image/jpeg,image/png";

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
  const [items, setItems] = useState<RecentPrint[]>(prints);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"idle" | "uploading" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);

  const mutate = (fn: (draft: RecentPrint[]) => RecentPrint[]) => {
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

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setBusy("uploading");
    setError(null);
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
      if (!res.ok || !data.id || !data.photoExt) {
        setError(data.error?.message ?? "Upload failed.");
        return;
      }
      mutate((draft) => [
        {
          id: data.id!,
          caption: file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, MAX_CAPTION_LENGTH),
          material: "PLA",
          photoExt: data.photoExt!,
          createdAt: new Date().toISOString(),
        },
        ...draft,
      ]);
    } catch {
      setError("Network error while uploading.");
    } finally {
      setBusy("idle");
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const save = async () => {
    setBusy("saving");
    setError(null);
    try {
      const res = await fetch("/api/admin/showcase", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ prints: items }),
      });
      if (!res.ok) {
        setError("Saving the showcase failed.");
        return;
      }
      const data = (await res.json()) as { prints: RecentPrint[] };
      // Take the server's normalized list back: an entry it rejected (an empty
      // caption, say) must disappear here too rather than look saved.
      setItems(data.prints);
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
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            id="showcase-photo"
            onChange={(e) => void onPick(e.target.files?.[0])}
          />
          <label htmlFor="showcase-photo" className="btn-pill cursor-pointer text-sm">
            {busy === "uploading" ? (
              <>
                <Loader2 strokeWidth={2} className="size-4 animate-spin" /> Uploading…
              </>
            ) : (
              <>
                <ImagePlus strokeWidth={1.65} className="size-4" /> Add photo
              </>
            )}
          </label>
          <p className="text-xs text-faint">
            JPEG or PNG, up to 8&nbsp;MB. Location and camera data are stripped on upload.
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
                  src={`/api/showcase/${item.id}/photo`}
                  alt=""
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
