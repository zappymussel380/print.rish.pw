"use client";

import { create } from "zustand";
import {
  DEFAULT_MODEL_CONFIG,
  type ModelConfig,
  type SliceJobStage,
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
  status: "uploading" | "ready" | "error";
  progress: number;
  error?: string;
  server?: UploadedModelDto;
  config: ModelConfig;
}

/** Slice cache entry, keyed by `${modelId}::${settingsKey}`. Holds every
 *  settings combination a model has been sliced at this session, so toggling
 *  back to a prior setting reprices instantly. */
export interface SliceState {
  status: SliceJobStage;
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
  markReady: (key: string, server: UploadedModelDto) => void;
  markError: (key: string, error: string) => void;
  updateConfig: (key: string, patch: Partial<ModelConfig>) => void;
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
    })),

  setProgress: (key, progress) =>
    set((s) => ({
      models: s.models.map((m) => (m.key === key ? { ...m, progress } : m)),
    })),

  markReady: (key, server) =>
    set((s) => ({
      models: s.models.map((m) =>
        m.key === key
          ? { ...m, key: server.id, status: "ready", progress: 1, server, error: undefined }
          : m,
      ),
    })),

  markError: (key, error) =>
    set((s) => ({
      models: s.models.map((m) => (m.key === key ? { ...m, status: "error", error } : m)),
    })),

  updateConfig: (key, patch) =>
    set((s) => ({
      models: s.models.map((m) => (m.key === key ? { ...m, config: { ...m.config, ...patch } } : m)),
    })),

  remove: (key) => set((s) => ({ models: s.models.filter((m) => m.key !== key) })),

  clear: () => set({ models: [], slices: {}, shipping: null }),

  setSlice: (cacheKey, state) =>
    set((s) => ({ slices: { ...s.slices, [cacheKey]: state } })),

  setShipping: (shipping) => set({ shipping }),
}));
