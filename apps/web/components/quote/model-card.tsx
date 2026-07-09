"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, Box, Clock, IndianRupee, Loader2, Trash2, Weight } from "lucide-react";
import {
  CATALOG,
  formatDuration,
  formatGrams,
  formatPaise,
  priceLine,
  settingsKey,
} from "@print/shared";
import { formatDimensions, formatBytes, formatVolume } from "@/lib/format";
import { type QuoteModel, sliceCacheKey, useQuoteStore } from "@/lib/quote-store";
import { deleteModel } from "@/lib/upload-client";
import { useSliceSync } from "@/hooks/use-slice-sync";
import { SettingsPanel } from "./settings-panel";

const ModelViewer = dynamic(() => import("./model-viewer"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-muted">
      <Loader2 strokeWidth={1.65} className="h-6 w-6 animate-spin" />
    </div>
  ),
});

export function ModelCard({ model }: { model: QuoteModel }) {
  useSliceSync(model);

  const remove = useQuoteStore((s) => s.remove);
  const slices = useQuoteStore((s) => s.slices);
  const [removing, setRemoving] = useState(false);
  const [view3d, setView3d] = useState(false);
  const [wireframe, setWireframe] = useState(false);

  const server = model.server;
  const hasSlicedOnce =
    !!server &&
    Object.entries(slices).some(([k, v]) => k.startsWith(`${server.id}::`) && v.status === "done");
  const slice = server ? slices[sliceCacheKey(server.id, settingsKey(model.config))] : undefined;

  const line =
    slice?.status === "done" && slice.result
      ? priceLine({ modelId: server!.id, config: model.config, stats: slice.result }, CATALOG)
      : null;

  const onRemove = async () => {
    setRemoving(true);
    try {
      if (model.status === "ready" && server) await deleteModel(server.id);
      remove(model.key);
    } catch {
      setRemoving(false);
    }
  };

  return (
    <li className="tile overflow-hidden">
      <div className="grid gap-0 md:grid-cols-[minmax(0,220px)_1fr]">
        {/* Preview */}
        <div className="relative aspect-square border-b border-line bg-[color-mix(in_srgb,var(--line)_18%,transparent)] md:aspect-auto md:border-b-0 md:border-r">
          {model.status === "ready" && server && view3d ? (
            <ModelViewer modelId={server.id} format={server.format} wireframe={wireframe} />
          ) : hasSlicedOnce && server ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/models/${server.id}/thumb`}
              alt={`Preview of ${model.fileName}`}
              className="h-full w-full object-contain p-2"
            />
          ) : (
            <div className="grid h-full min-h-[180px] place-items-center text-faint">
              {model.status === "error" ? (
                <AlertTriangle strokeWidth={1.4} className="h-10 w-10 text-accent" />
              ) : (
                <Box strokeWidth={1.2} className="h-12 w-12" />
              )}
            </div>
          )}

          {model.status === "ready" && server && (
            <div className="absolute bottom-2 left-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => setView3d((v) => !v)}
                className="chip chip-accent cursor-pointer"
                aria-pressed={view3d}
              >
                {view3d ? "Image" : "3D view"}
              </button>
              {view3d && (
                <button
                  type="button"
                  onClick={() => setWireframe((w) => !w)}
                  className="chip cursor-pointer"
                  aria-pressed={wireframe}
                >
                  {wireframe ? "Solid" : "Wire"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="min-w-0 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-[650]" title={model.fileName}>
                {model.fileName}
              </p>
              <p className="mt-0.5 text-xs text-faint">
                {server ? server.format.toUpperCase() : ""} · {formatBytes(model.sizeBytes)}
              </p>
            </div>
            <button
              type="button"
              onClick={onRemove}
              disabled={removing || model.status === "uploading"}
              aria-label={`Remove ${model.fileName}`}
              className="shrink-0 rounded-md p-2 text-faint transition-colors hover:text-accent disabled:opacity-40"
            >
              {removing ? (
                <Loader2 strokeWidth={1.65} className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 strokeWidth={1.65} className="h-4 w-4" />
              )}
            </button>
          </div>

          {model.status === "uploading" && <UploadProgress progress={model.progress} />}

          {model.status === "error" && (
            <p className="mt-3 text-sm text-accent" aria-live="polite">
              {model.error ?? "Upload failed"}
            </p>
          )}

          {model.status === "ready" && server && (
            <>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
                <span>{formatDimensions(server.bboxMm)}</span>
                <span>{formatVolume(server.volumeCm3)}</span>
                {!server.fitsBed && (
                  <span className="inline-flex items-center gap-1 text-accent">
                    <AlertTriangle strokeWidth={1.65} className="h-3.5 w-3.5" />
                    Larger than the 256mm bed
                  </span>
                )}
              </div>

              <SliceStatsRow slice={slice} line={line} />

              <div className="mt-5 border-t border-line pt-5">
                <SettingsPanel
                  modelKey={model.key}
                  config={model.config}
                  lockedConfig={server.lockedConfig}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function UploadProgress({ progress }: { progress: number }) {
  const pct = Math.round(progress * 100);
  return (
    <div className="mt-4">
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--line)_60%,transparent)]"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted">Uploading… {pct}%</p>
    </div>
  );
}

function SliceStatsRow({
  slice,
  line,
}: {
  slice: ReturnType<typeof useQuoteStore.getState>["slices"][string] | undefined;
  line: ReturnType<typeof priceLine> | null;
}) {
  const pending = !slice || slice.status === "queued" || slice.status === "slicing";
  const failed = slice?.status === "failed";

  return (
    <div className="mt-4 grid grid-cols-3 gap-3" aria-live="polite">
      <Stat icon={<Weight strokeWidth={1.65} className="h-4 w-4" />} label="Filament">
        {failed ? "—" : line ? formatGrams(line.totalGrams) : <Skel />}
      </Stat>
      <Stat icon={<Clock strokeWidth={1.65} className="h-4 w-4" />} label="Print time">
        {failed ? "—" : line ? formatDuration(line.totalPrintSeconds) : <Skel />}
      </Stat>
      <Stat icon={<IndianRupee strokeWidth={1.65} className="h-4 w-4" />} label="Line price">
        {failed ? "—" : line ? formatPaise(line.subtotalPaise) : <Skel />}
      </Stat>
      {pending && !failed && (
        <p className="col-span-3 -mt-1 flex items-center gap-1.5 text-xs text-muted">
          <Loader2 strokeWidth={1.65} className="h-3.5 w-3.5 animate-spin" /> Slicing with OrcaSlicer…
        </p>
      )}
      {failed && (
        <p className="col-span-3 -mt-1 text-xs text-accent">
          {slice?.error?.message ?? "Slicing failed — adjust settings and try again."}
        </p>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-[color-mix(in_srgb,var(--surface)_60%,transparent)] p-3">
      <span className="flex items-center gap-1 text-[0.65rem] font-[650] uppercase tracking-[0.12em] text-faint">
        {icon}
        {label}
      </span>
      <span className="mt-1.5 block text-[0.95rem] font-[650]">{children}</span>
    </div>
  );
}

function Skel() {
  return <span className="skeleton inline-block h-4 w-14 align-middle" />;
}
