import type { SliceJobStage, SliceProgress, SliceSettings, SliceStats } from "@print/shared";

export interface SliceStatusDto {
  sliceId: string;
  status: SliceJobStage;
  progress: SliceProgress;
  result: SliceStats | null;
  error: { code: string; message: string } | null;
}

/** Kick off (or fetch cached) a slice for a model at given settings. */
export async function requestSlice(
  modelId: string,
  settings: SliceSettings,
  signal?: AbortSignal,
): Promise<SliceStatusDto> {
  const res = await fetch("/api/slices", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ modelId, settings }),
    signal,
  });
  return readDto(res);
}

/** Poll a slice's current state by its result-row id. */
export async function pollSlice(sliceId: string, signal?: AbortSignal): Promise<SliceStatusDto> {
  const res = await fetch(`/api/slices/${sliceId}`, { signal });
  return readDto(res);
}

async function readDto(res: Response): Promise<SliceStatusDto> {
  if (!res.ok) {
    let message = `Slice request failed (HTTP ${res.status})`;
    let code = "SLICE_REQUEST_FAILED";
    try {
      const body = (await res.json()) as { error?: { code: string; message: string } };
      if (body.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      /* non-JSON */
    }
    return {
      sliceId: "",
      status: "failed",
      progress: { percent: 0, stage: "failed", message: "Slicing failed" },
      result: null,
      error: { code, message },
    };
  }
  return (await res.json()) as SliceStatusDto;
}
