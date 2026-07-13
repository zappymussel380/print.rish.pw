"use client";

import { create } from "zustand";
import {
  DEFAULT_MODEL_CONFIG,
  type ModelConfig,
  type SliceJobStage,
  type SliceProgress,
  type SliceStats,
} from "@print/shared";
import type { UploadedModelDto } from "./upload-client";

/** One row in the quote builder. A model starts life as an `uploading` entry
 *  keyed by a client-generated id, then gains its server record on success. */
export interface QuoteModel {
  /** Stable client key; equals the server id once uploaded. */
  key: string;
  fileName: string;
  sizeBytes: number;
  status: "uploading" | "queued" | "processing" | "ready" | "error";
  progress: number;
  /** BullMQ ticket while inspection is queued/running. Never used as a path. */
  ticket?: string;
  /** Server-authoritative count of jobs ahead (zero means next). */
  modelsAhead?: number;
  processorOnline?: boolean;
  error?: string;
  server?: UploadedModelDto;
  config: ModelConfig;
}

/** Slice cache entry, keyed by `${modelId}::${settingsKey}`. Holds every
 *  settings combination a model has been sliced at this session, so toggling
 *  back to a prior setting reprices instantly. */
export interface SliceState {
  status: SliceJobStage;
  progress?: SliceProgress;
  sliceId?: string;
  result?: SliceStats;
  error?: { code: string; message: string };
}

export function sliceCacheKey(modelId: string, settingsKey: string): string {
  return `${modelId}::${settingsKey}`;
}

/** A shipping estimate the customer ran on the quote page, carried through to
 *  checkout. `quoteKey` (grams:totalPaise) ties it to the exact quote it was
 *  estimated for, so the client hides it if the quote has since changed. `token`
 *  is the server-signed proof of the shown amount that checkout verifies before
 *  charging it — the amount/pincode/days here are for display only. */
export interface SavedShipping {
  pincode: string;
  amountPaise: number;
  days: string | null;
  token: string;
  quoteKey: string;
}

interface QuoteState {
  models: QuoteModel[];
  slices: Record<string, SliceState>;
  shipping: SavedShipping | null;

  addUploading: (key: string, fileName: string, sizeBytes: number) => void;
  setProgress: (key: string, progress: number) => void;
  markQueued: (
    key: string,
    ticket: string,
    position: number,
    processorOnline?: boolean,
  ) => void;
  markProcessing: (key: string, ticket: string) => void;
  markReadyMany: (key: string, servers: UploadedModelDto[], ticket: string) => void;
  markError: (key: string, error: string, ticket?: string) => void;
  updateConfig: (key: string, patch: Partial<ModelConfig>) => void;
  restoreModels: (models: UploadedModelDto[]) => void;
  remove: (key: string) => void;
  clear: () => void;

  setSlice: (cacheKey: string, state: SliceState) => void;
  setShipping: (shipping: SavedShipping | null) => void;
}

export const useQuoteStore = create<QuoteState>((set) => ({
  models: [],
  slices: {},
  shipping: null,

  addUploading: (key, fileName, sizeBytes) =>
    set((s) => ({
      models: [
        ...s.models,
        { key, fileName, sizeBytes, status: "uploading", progress: 0, config: { ...DEFAULT_MODEL_CONFIG } },
      ],
      shipping: null,
    })),

  setProgress: (key, progress) =>
    set((s) => ({
      models: s.models.map((m) =>
        m.key === key && m.status === "uploading" ? { ...m, progress } : m,
      ),
    })),

  markQueued: (key, ticket, position, processorOnline) =>
    set((s) => ({
      models: s.models.map((m) => {
        if (m.key !== key || !isIngestPending(m.status)) return m;
        // The first transition installs the ticket. Thereafter it is the fence
        // that prevents an older poll response from changing a reused row.
        if (m.status === "uploading" ? !!m.ticket : m.ticket !== ticket) return m;
        return {
          ...m,
          status: "queued",
          progress: 1,
          ticket,
          modelsAhead: Math.max(0, Math.floor(position)),
          processorOnline,
          error: undefined,
        };
      }),
    })),

  markProcessing: (key, ticket) =>
    set((s) => ({
      models: s.models.map((m) =>
        m.key === key && m.ticket === ticket && isIngestPending(m.status)
          ? {
              ...m,
              status: "processing",
              modelsAhead: undefined,
              processorOnline: undefined,
              error: undefined,
            }
          : m,
      ),
    })),

  markReadyMany: (key, servers, ticket) =>
    set((s) => {
      if (servers.length === 0) return s;
      const index = s.models.findIndex((m) => m.key === key && m.ticket === ticket);
      if (index === -1) return s;

      const current = s.models[index]!;
      if (!isIngestPending(current.status)) return s;

      // A models refresh can race the final ticket poll. Keep each durable
      // server id once while still removing the now-obsolete placeholder.
      const existingIds = new Set(
        s.models
          .filter((_model, modelIndex) => modelIndex !== index)
          .map((model) => model.server?.id)
          .filter((id): id is string => !!id),
      );
      const ready: QuoteModel[] = [];
      for (const server of servers) {
        if (existingIds.has(server.id)) continue;
        existingIds.add(server.id);
        ready.push({
          key: server.id,
          fileName: server.originalName,
          sizeBytes: server.sizeBytes,
          status: "ready",
          progress: 1,
          ticket: undefined,
          modelsAhead: undefined,
          processorOnline: undefined,
          server,
          error: undefined,
          config: { ...current.config, ...server.defaultConfig },
        });
      }
      const models = [...s.models];
      models.splice(index, 1, ...ready);
      return { models, shipping: null };
    }),

  markError: (key, error, ticket) =>
    set((s) => ({
      models: s.models.map((m) => {
        if (m.key !== key || (ticket !== undefined && m.ticket !== ticket)) return m;
        if (ticket !== undefined && !isIngestPending(m.status)) return m;
        return {
          ...m,
          status: "error",
          ticket: undefined,
          modelsAhead: undefined,
          processorOnline: undefined,
          error,
        };
      }),
    })),

  updateConfig: (key, patch) =>
    set((s) => ({
      models: s.models.map((m) =>
        m.key === key ? { ...m, config: { ...m.config, ...filterUnlocked(m, patch) } } : m,
      ),
    })),

  restoreModels: (models) =>
    set((s) => {
      const existing = new Set(s.models.map((m) => m.server?.id).filter((id): id is string => !!id));
      const restored: QuoteModel[] = models
        .filter((server) => !existing.has(server.id))
        .map((server) => ({
          key: server.id,
          fileName: server.originalName,
          sizeBytes: server.sizeBytes,
          status: "ready",
          progress: 1,
          server,
          config: { ...DEFAULT_MODEL_CONFIG, ...server.defaultConfig },
        }));
      if (restored.length === 0) return s;
      return { models: [...s.models, ...restored], shipping: null };
    }),

  remove: (key) => set((s) => ({ models: s.models.filter((m) => m.key !== key) })),

  clear: () => set({ models: [], slices: {}, shipping: null }),

  setSlice: (cacheKey, state) =>
    set((s) => ({ slices: { ...s.slices, [cacheKey]: state } })),

  setShipping: (shipping) => set({ shipping }),
}));

function filterUnlocked(model: QuoteModel, patch: Partial<ModelConfig>): Partial<ModelConfig> {
  const locked = model.server?.lockedConfig;
  if (!locked) return patch;
  const next = { ...patch };
  for (const key of Object.keys(locked) as (keyof ModelConfig)[]) {
    delete next[key];
  }
  return next;
}

export function isIngestPending(status: QuoteModel["status"]): boolean {
  return status === "uploading" || status === "queued" || status === "processing";
}
