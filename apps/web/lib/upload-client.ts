import type {
  IngestPublicFailure,
  MaterialId,
  UploadedModelDto,
  UploadAcceptedDto,
  UploadTicketDto,
} from "@print/shared";

export type { UploadedModelDto, UploadAcceptedDto, UploadTicketDto } from "@print/shared";

export type UploadError = IngestPublicFailure;

export class UploadClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "UploadClientError";
  }
}

/** The formats the server will accept, used to filter before sending. */
export const ACCEPTED_EXTENSIONS = [".stl", ".3mf", ".obj", ".amf", ".step", ".stp"] as const;
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(",");

export function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function defaultMaterialColour(): { material: MaterialId; colour: "black" | "white" } {
  return { material: "PLA", colour: "black" };
}

/**
 * Upload one file with real transport progress. Resolves as soon as the server
 * has durably queued the file; model inspection continues through the ticket
 * endpoint and never masquerades as upload-byte progress.
 */
export function uploadModel(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadAcceptedDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    let settled = false;
    form.append("file", file, file.name);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      fn();
    };
    const fail = (error: UploadClientError) => finish(() => reject(error));
    const abort = () => xhr.abort();

    xhr.open("POST", "/api/uploads");
    // Same-origin XHR from our own page always sends Sec-Fetch-Site; this header
    // additionally satisfies the Origin-based CSRF check on older engines.
    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(1, Math.max(0, event.loaded / event.total)));
      }
    };

    xhr.onload = () => {
      const body = parseJson(xhr.responseText);
      if (xhr.status === 202) {
        const accepted = parseAccepted(body);
        if (accepted) {
          finish(() => resolve(accepted));
          return;
        }
        fail(
          new UploadClientError(
            "UPLOAD_FAILED",
            "Upload was accepted but returned no processing ticket",
          ),
        );
        return;
      }

      const serverError = readError(body);
      fail(
        new UploadClientError(
          serverError?.code ?? "UPLOAD_FAILED",
          serverError?.message ?? `Upload failed (HTTP ${xhr.status})`,
        ),
      );
    };

    xhr.onerror = () =>
      fail(new UploadClientError("NETWORK", "Network error during upload", true));
    xhr.ontimeout = () =>
      fail(new UploadClientError("TIMEOUT", "Upload timed out", true));
    xhr.onabort = () =>
      fail(new UploadClientError("ABORTED", "Upload cancelled"));

    if (signal) {
      if (signal.aborted) {
        fail(new UploadClientError("ABORTED", "Upload cancelled"));
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }

    xhr.send(form);
  });
}

/** Read the current server-authoritative state of an accepted upload. */
export async function pollUpload(
  ticket: string,
  signal?: AbortSignal,
): Promise<UploadTicketDto> {
  let response: Response;
  try {
    response = await fetch(`/api/uploads/status/${encodeURIComponent(ticket)}`, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new UploadClientError("NETWORK", "Connection lost while checking the model", true);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const serverError = readError(body);
    const retryable = response.status === 429 || response.status >= 500;
    throw new UploadClientError(
      serverError?.code ?? "UPLOAD_STATUS_FAILED",
      serverError?.message ?? `Could not check upload (HTTP ${response.status})`,
      retryable,
      response.status === 429 ? retryAfterMs(response.headers.get("Retry-After")) : undefined,
    );
  }

  const ticketState = parseTicket(body);
  if (!ticketState) {
    throw new UploadClientError(
      "UPLOAD_STATUS_FAILED",
      "The processor returned an invalid upload status",
    );
  }
  return ticketState;
}

/** Customer-facing queue copy. `position` is the count ahead, not an ordinal. */
export function uploadQueueMessage(
  position: number,
  processorOnline: boolean | undefined,
): string {
  const ahead = Math.max(0, Math.floor(position));
  if (processorOnline === false) {
    return ahead === 0
      ? "The model processor is offline. Your model is next when it returns."
      : `The model processor is offline. ${ahead} ${ahead === 1 ? "model" : "models"} ahead of you.`;
  }
  if (ahead === 0) return "Waiting for the processor. Your model is next.";
  return `Waiting for the processor. ${ahead} ${ahead === 1 ? "model" : "models"} ahead of you.`;
}

export async function deleteModel(id: string): Promise<void> {
  const res = await fetch(`/api/models/${id}`, {
    method: "DELETE",
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  if (!res.ok) {
    let message = `Could not remove model (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: UploadError };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseAccepted(value: unknown): UploadAcceptedDto | null {
  if (!isRecord(value)) return null;
  if (typeof value.ticket !== "string" || !Number.isInteger(value.position)) return null;
  if ((value.position as number) < 0) return null;
  return { ticket: value.ticket, position: value.position as number };
}

function readError(value: unknown): UploadError | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const { code, message } = value.error;
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

function parseTicket(value: unknown): UploadTicketDto | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (value.status === "queued") {
    if (!Number.isInteger(value.position) || (value.position as number) < 0) return null;
    if (typeof value.processorOnline !== "boolean") return null;
    return {
      status: "queued",
      position: value.position as number,
      processorOnline: value.processorOnline,
    };
  }
  if (value.status === "processing") return { status: "processing" };
  if (value.status === "failed") {
    const error = readError({ error: value.error });
    return error ? { status: "failed", error } : null;
  }
  if (value.status === "done") {
    if (!isUploadedModel(value.model) || !Array.isArray(value.models) || value.models.length === 0) {
      return null;
    }
    if (!value.models.every(isUploadedModel)) return null;
    return { status: "done", model: value.model, models: value.models };
  }
  return null;
}

function isUploadedModel(value: unknown): value is UploadedModelDto {
  if (!isRecord(value) || !isRecord(value.bboxMm)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.originalName === "string" &&
    typeof value.format === "string" &&
    typeof value.sizeBytes === "number" &&
    typeof value.bboxMm.x === "number" &&
    typeof value.bboxMm.y === "number" &&
    typeof value.bboxMm.z === "number" &&
    typeof value.volumeCm3 === "number" &&
    typeof value.fitsBed === "boolean"
  );
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}
