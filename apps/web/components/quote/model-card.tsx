"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, Box, Clock, IndianRupee, Loader2, Trash2, Weight } from "lucide-react";
import {
  formatDuration,
  formatGrams,
  formatPaise,
  priceLine,
  settingsKey,
  type SupportMode,
} from "@print/shared";
import { formatDimensions, formatBytes, formatVolume } from "@/lib/format";
import { previewColour, tintThumbPixels } from "@/lib/preview-colour";
import {
  type QuoteModel,
  isIngestPending,
  sliceCacheKey,
  useQuoteStore,
} from "@/lib/quote-store";
import { deleteModel, uploadQueueMessage } from "@/lib/upload-client";
import { useSliceSync } from "@/hooks/use-slice-sync";
import { useUploadSync } from "@/hooks/use-upload-sync";
import { useCatalog } from "@/lib/use-catalog";
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
  useUploadSync(model);
  useSliceSync(model);

  const remove = useQuoteStore((s) => s.remove);
  const slices = useQuoteStore((s) => s.slices);
  const catalog = useCatalog();
  const { pricing } = catalog;
  // Preview in the chosen filament colour (a gradient's first stop).
  const chosen = catalog.materials.find((m) => m.id === model.config.material)?.colours.find((c) => c.id === model.config.colour);
  const tint = previewColour(chosen?.stops?.[0] ?? chosen?.hex);
  const [removing, setRemoving] = useState(false);
  const [view3d, setView3d] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const ingestPending = isIngestPending(model.status);

  const server = model.server;
  const hasSlicedOnce =
    !!server &&
    Object.entries(slices).some(([k, v]) => k.startsWith(`${server.id}::`) && v.status === "done");
  const slice = server ? slices[sliceCacheKey(server.id, settingsKey(model.config))] : undefined;

  const line =
    slice?.status === "done" && slice.result
      ? priceLine({ modelId: server!.id, config: model.config, stats: slice.result }, pricing)
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
            <ModelViewer modelId={server.id} format={server.format} wireframe={wireframe} colour={tint} />
          ) : hasSlicedOnce && server ? (
            <TintedThumb src={`/api/models/${server.id}/thumb`} tint={tint} alt={`Preview of ${model.fileName}`} />
          ) : (
            <div className="grid h-full min-h-[180px] place-items-center text-faint">
              {model.status === "error" ? (
                <AlertTriangle strokeWidth={1.4} className="h-10 w-10 text-danger" />
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
                {server ? `${server.format.toUpperCase()} · ` : ""}
                {formatBytes(model.sizeBytes)}
              </p>
            </div>
            <button
              type="button"
              onClick={onRemove}
              disabled={removing || ingestPending}
              aria-label={`Remove ${model.fileName}`}
              title={ingestPending ? "Available after model checking finishes" : undefined}
              className="shrink-0 rounded-md p-2 text-faint transition-colors hover:text-danger disabled:opacity-40"
            >
              {removing ? (
                <Loader2 strokeWidth={1.65} className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 strokeWidth={1.65} className="h-4 w-4" />
              )}
            </button>
          </div>

          {model.status === "uploading" && <UploadProgress progress={model.progress} />}

          {model.status === "queued" && (
            <IngestStatus>
              {uploadQueueMessage(model.modelsAhead ?? 0, model.processorOnline)}
            </IngestStatus>
          )}

          {model.status === "processing" && (
            <IngestStatus>Checking your model.</IngestStatus>
          )}

          {model.status === "error" && (
            <p className="mt-3 text-sm text-danger" aria-live="polite">
              {model.error ?? "Upload failed"}
            </p>
          )}

          {model.status === "ready" && server && (
            <>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
                <span>{formatDimensions(server.bboxMm)}</span>
                <span>{formatVolume(server.volumeCm3)}</span>
                {!!server.partCount && server.partCount > 1 && (
                  <span title="Parts from your file, arranged onto the plate and priced together">
                    {server.partCount} parts
                  </span>
                )}
                {!server.fitsBed && (
                  <span className="inline-flex items-center gap-1 text-danger">
                    <AlertTriangle strokeWidth={1.65} className="h-3.5 w-3.5" />
                    Larger than the 256mm bed
                  </span>
                )}
              </div>

              <SliceStatsRow slice={slice} line={line} supports={model.config.supports} />

              <div className="mt-5 border-t border-line pt-5">
                <SettingsPanel
                  modelKey={model.key}
                  config={model.config}
                  sourceConfig={server.sourceConfig}
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

function IngestStatus({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mt-3 text-sm text-muted"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {children}
    </p>
  );
}

function UploadProgress({ progress }: { progress: number }) {
  const pct = Math.round(progress * 100);
  const label = pct >= 100 ? "Finishing upload" : "Uploading";
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
      <p className="mt-1.5 text-xs text-muted">
        {label}: <span className="tabular-nums">{pct}%</span>
      </p>
    </div>
  );
}

function SliceStatsRow({
  slice,
  line,
  supports,
}: {
  slice: ReturnType<typeof useQuoteStore.getState>["slices"][string] | undefined;
  line: ReturnType<typeof priceLine> | null;
  supports: SupportMode;
}) {
  const pending = !slice || !["done", "failed"].includes(slice.status);
  const failed = slice?.status === "failed";
  // What the slicer did about supports: they're filament the customer pays for.
  const supportGrams = slice?.status === "done" ? slice.result?.supportGrams : undefined;
  const supportNote =
    line && supports !== "off" && supportGrams != null
      ? supportGrams > 0
        ? `Includes about ${formatGrams(supportGrams)} of supports per print, which the slicer added under overhangs.`
        : "No supports needed for this part."
      : null;

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
      {supportNote ? <p className="col-span-3 -mt-1 text-xs text-faint">{supportNote}</p> : null}
      {pending && !failed && (
        <SliceProgress progress={slice?.progress} />
      )}
      {failed && (
        <p className="col-span-3 -mt-1 text-xs text-danger">
          {slice?.error?.message ?? "Slicing failed. Adjust settings and try again."}
        </p>
      )}
    </div>
  );
}

function SliceProgress({
  progress,
}: {
  progress: ReturnType<typeof useQuoteStore.getState>["slices"][string]["progress"];
}) {
  const percent = Math.min(99, Math.max(0, progress?.percent ?? 0));
  const message = progress?.message ?? "Waiting for a slicer";
  return (
    <div className="col-span-3 -mt-1" aria-live="polite">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-muted">
        <span className="min-w-0 truncate" title={message}>
          {message}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-text">{percent}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--line)_60%,transparent)]"
        role="progressbar"
        aria-label={`Slicing: ${message}`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
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

/** The server's grey thumbnail, recoloured in the browser to the chosen
 *  filament. Shows the grey image until the tint is ready, or if it fails. */
function TintedThumb({ src, tint, alt }: { src: string; tint: string | null; alt: string }) {
  const [tinted, setTinted] = useState<{ key: string; url: string } | null>(null);
  const key = `${src}|${tint}`;

  useEffect(() => {
    if (!tint) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        tintThumbPixels(pixels.data, tint);
        ctx.putImageData(pixels, 0, 0);
        if (alive) setTinted({ key, url: canvas.toDataURL("image/png") });
      } catch {
        // A canvas that can't be read keeps the grey image.
      }
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src, tint, key]);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={tint && tinted?.key === key ? tinted.url : src} alt={alt} className="h-full w-full object-contain p-2" />
  );
}
