"use client";

import { useEffect, useRef } from "react";
import { settingsKey } from "@print/shared";
import { type QuoteModel, sliceCacheKey, useQuoteStore } from "@/lib/quote-store";
import { pollSlice, requestSlice } from "@/lib/slice-client";

const DEBOUNCE_MS = 600;
const POLL_MS = 1500;

/**
 * Drives slicing for one model. When the model is ready and its slice-relevant
 * settings change, this debounces, requests a slice, and polls to completion —
 * writing every result into the store's slice cache so prior settings reprice
 * instantly. Colour and quantity never appear in settingsKey, so changing them
 * does not re-slice.
 */
export function useSliceSync(model: QuoteModel): void {
  const setSlice = useQuoteStore((s) => s.setSlice);
  const timers = useRef<{ debounce?: ReturnType<typeof setTimeout>; abort?: AbortController }>({});

  const ready = model.status === "ready" && !!model.server;
  const key = ready ? settingsKey(model.config) : "";
  const modelId = model.server?.id ?? "";

  useEffect(() => {
    if (!ready) return;
    const cacheKey = sliceCacheKey(modelId, key);

    // Already have (or are already fetching) this combination — do nothing.
    const current = useQuoteStore.getState().slices[cacheKey];
    if (current && current.status !== "failed") return;

    const abort = new AbortController();
    timers.current.abort?.abort();
    timers.current.abort = abort;

    const start = async () => {
      setSlice(cacheKey, {
        status: "queued",
        progress: { percent: 0, stage: "queued", message: "Waiting for a slicer" },
      });
      try {
        let dto = await requestSlice(modelId, model.config, abort.signal);
        while (dto.status !== "done" && dto.status !== "failed") {
          if (!dto.sliceId) break;
          setSlice(cacheKey, {
            status: dto.status,
            sliceId: dto.sliceId,
            progress: dto.progress,
          });
          await sleep(POLL_MS, abort.signal);
          dto = await pollSlice(dto.sliceId, abort.signal);
        }
        if (dto.status === "done" && dto.result) {
          setSlice(cacheKey, {
            status: "done",
            sliceId: dto.sliceId,
            progress: dto.progress,
            result: dto.result,
          });
        } else {
          setSlice(cacheKey, {
            status: "failed",
            progress: dto.progress,
            error: dto.error ?? { code: "SLICE_FAILED", message: "Slicing failed" },
          });
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        setSlice(cacheKey, {
          status: "failed",
          progress: { percent: 0, stage: "failed", message: "Connection lost" },
          error: { code: "NETWORK", message: err instanceof Error ? err.message : "Slice error" },
        });
      }
    };

    timers.current.debounce = setTimeout(start, DEBOUNCE_MS);
    return () => {
      clearTimeout(timers.current.debounce);
      abort.abort();
    };
  }, [ready, modelId, key, model.config, setSlice]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
