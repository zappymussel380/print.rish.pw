import type { BoundingBoxMm, MaterialId, ModelConfig } from "@print/shared";

/** Shape returned by POST /api/uploads on success. */
export interface UploadedModelDto {
  id: string;
  originalName: string;
  format: string;
  sizeBytes: number;
  bboxMm: BoundingBoxMm;
  volumeCm3: number;
  triangleCount?: number;
  fitsBed: boolean;
  defaultConfig?: Partial<ModelConfig>;
  sourceConfig?: Partial<ModelConfig>;
  lockedConfig?: Partial<Record<keyof ModelConfig, true>>;
}

interface UploadResponse {
  model?: UploadedModelDto;
  models?: UploadedModelDto[];
}

export interface UploadError {
  code: string;
  message: string;
}

/** The formats the server will accept — used to filter before we even send. */
export const ACCEPTED_EXTENSIONS = [".stl", ".3mf", ".obj", ".amf"] as const;
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(",");

export function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function defaultMaterialColour(): { material: MaterialId; colour: "black" | "white" } {
  return { material: "PLA", colour: "black" };
}

/**
 * Upload a single file with real progress events. Uses XHR (not fetch) because
 * only XHR exposes `upload.onprogress`. Resolves with every created model; a
 * multi-plate 3MF can intentionally expand into several model rows.
 */
export function uploadModel(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadedModelDto[]> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file, file.name);

    xhr.open("POST", "/api/uploads");
    // Same-origin XHR from our own page always sends Sec-Fetch-Site; this header
    // additionally satisfies the Origin-based CSRF check on older engines.
    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        const success = body as UploadResponse;
        if (Array.isArray(success.models) && success.models.length > 0) {
          resolve(success.models);
          return;
        }
        if (success.model) {
          resolve([success.model]);
          return;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        reject({ code: "UPLOAD_FAILED", message: "Upload succeeded but returned no models" });
        return;
      }
      const err = body as { error?: UploadError } | null;
      reject(
        err?.error ?? {
          code: "UPLOAD_FAILED",
          message: `Upload failed (HTTP ${xhr.status})`,
        },
      );
    };

    xhr.onerror = () => reject({ code: "NETWORK", message: "Network error during upload" });
    xhr.ontimeout = () => reject({ code: "TIMEOUT", message: "Upload timed out" });

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        reject({ code: "ABORTED", message: "Upload cancelled" });
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.onabort = () => reject({ code: "ABORTED", message: "Upload cancelled" });

    xhr.send(form);
  });
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
