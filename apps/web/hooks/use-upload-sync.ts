"use client";

import { useEffect } from "react";
import { type QuoteModel, isIngestPending, useQuoteStore } from "@/lib/quote-store";
import { pollUpload, UploadClientError } from "@/lib/upload-client";

const POLL_MS = 1500;
const MAX_RETRY_MS = 15_000;

/**
 * Follows one accepted ingest ticket to a terminal state. Queue/worker state is
 * server-authoritative; local abort only stops polling when the card unmounts
 * and does not pretend to cancel the durable job.
 */
export function useUploadSync(model: QuoteModel): void {
  const markQueued = useQuoteStore((state) => state.markQueued);
  const markProcessing = useQuoteStore((state) => state.markProcessing);
  const markReadyMany = useQuoteStore((state) => state.markReadyMany);
  const markError = useQuoteStore((state) => state.markError);

  const key = model.key;
  const ticket = model.ticket;
  const shouldPoll = !!ticket && isIngestPending(model.status) && model.status !== "uploading";

  useEffect(() => {
    if (!shouldPoll || !ticket) return;
    const abort = new AbortController();

    const follow = async () => {
      let retryDelay = POLL_MS;
      while (!abort.signal.aborted) {
        try {
          const state = await pollUpload(ticket, abort.signal);
          retryDelay = POLL_MS;
          if (state.status === "queued") {
            markQueued(key, ticket, state.position, state.processorOnline);
          } else if (state.status === "processing") {
            markProcessing(key, ticket);
          } else if (state.status === "done") {
            markReadyMany(key, state.models, ticket);
            return;
          } else {
            markError(key, state.error.message, ticket);
            return;
          }
          await sleep(POLL_MS, abort.signal);
        } catch (error) {
          if (abort.signal.aborted) return;
          if (error instanceof UploadClientError && !error.retryable) {
            markError(key, error.message, ticket);
            return;
          }

          const requestedDelay =
            error instanceof UploadClientError ? error.retryAfterMs : undefined;
          await sleep(requestedDelay ?? retryDelay, abort.signal).catch(() => undefined);
          retryDelay = Math.min(MAX_RETRY_MS, retryDelay * 2);
        }
      }
    };

    void follow();
    return () => abort.abort();
  }, [key, markError, markProcessing, markQueued, markReadyMany, shouldPoll, ticket]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
