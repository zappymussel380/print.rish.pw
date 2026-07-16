import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCEPT_ATTR,
  hasAcceptedExtension,
  pollUpload,
  uploadModel,
  uploadQueueMessage,
  UploadClientError,
} from "@/lib/upload-client";

class FakeXmlHttpRequest {
  static response = { status: 202, body: "" };
  static autoLoad = true;

  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open() {}
  setRequestHeader() {}
  send() {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 4 } as ProgressEvent);
    this.status = FakeXmlHttpRequest.response.status;
    this.responseText = FakeXmlHttpRequest.response.body;
    if (FakeXmlHttpRequest.autoLoad) queueMicrotask(() => this.onload?.());
  }
  abort() {
    queueMicrotask(() => this.onabort?.());
  }
}

afterEach(() => {
  FakeXmlHttpRequest.autoLoad = true;
  vi.unstubAllGlobals();
});

describe("upload client", () => {
  it("resolves a 202 response with its queue ticket and transport progress", async () => {
    FakeXmlHttpRequest.response = {
      status: 202,
      body: JSON.stringify({
        ticket: "11111111-1111-4111-8111-111111111111",
        position: 2,
      }),
    };
    vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest);
    const progress = vi.fn();

    await expect(uploadModel(new File(["solid model"], "part.stl"), progress)).resolves.toEqual({
      ticket: "11111111-1111-4111-8111-111111111111",
      position: 2,
    });
    expect(progress).toHaveBeenCalledWith(0.75);
  });

  it("rejects a malformed successful upload response", async () => {
    FakeXmlHttpRequest.response = { status: 202, body: JSON.stringify({ position: 0 }) };
    vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest);

    await expect(uploadModel(new File(["solid model"], "part.stl"), vi.fn())).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
    });
  });

  it("aborts an in-flight XHR through the caller signal", async () => {
    FakeXmlHttpRequest.autoLoad = false;
    vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest);
    const abort = new AbortController();
    const upload = uploadModel(new File(["solid model"], "part.stl"), vi.fn(), abort.signal);

    abort.abort();

    await expect(upload).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("reads queued status and processor availability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ status: "queued", position: 1, processorOnline: false }),
      ),
    );

    await expect(pollUpload("ticket-1")).resolves.toEqual({
      status: "queued",
      position: 1,
      processorOnline: false,
    });
  });

  it("marks server and rate-limit failures as retryable and honors Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "RATE_LIMITED", message: "Slow down" } },
          { status: 429, headers: { "Retry-After": "3" } },
        ),
      ),
    );

    const failure = await pollUpload("ticket-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UploadClientError);
    expect(failure).toMatchObject({
      code: "RATE_LIMITED",
      message: "Slow down",
      retryable: true,
      retryAfterMs: 3000,
    });
  });

  it("rejects invalid successful status payloads without retrying forever", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "queued", position: -1 })));

    await expect(pollUpload("ticket-1")).rejects.toMatchObject({
      code: "UPLOAD_STATUS_FAILED",
      retryable: false,
    });
  });
});

describe("accepted upload formats", () => {
  it("accepts STEP alongside the mesh formats", () => {
    expect(hasAcceptedExtension("bracket.step")).toBe(true);
    expect(hasAcceptedExtension("bracket.STP")).toBe(true);
    expect(hasAcceptedExtension("part.stl")).toBe(true);
    expect(hasAcceptedExtension("part.gcode")).toBe(false);
    expect(ACCEPT_ATTR).toContain(".step");
    expect(ACCEPT_ATTR).toContain(".stp");
  });
});

describe("queue status copy", () => {
  it("uses the server value as a count ahead with correct singular/plural copy", () => {
    expect(uploadQueueMessage(0, true)).toBe("Waiting for the processor. Your model is next.");
    expect(uploadQueueMessage(1, true)).toContain("1 model ahead of you");
    expect(uploadQueueMessage(2, true)).toContain("2 models ahead of you");
  });

  it("distinguishes an offline processor without inventing an ETA", () => {
    expect(uploadQueueMessage(0, false)).toBe(
      "The model processor is offline. Your model is next when it returns.",
    );
  });
});
