import { beforeEach, describe, expect, it } from "vitest";
import type { UploadedModelDto } from "@print/shared";
import { useQuoteStore } from "@/lib/quote-store";

const TICKET = "11111111-1111-4111-8111-111111111111";

function model(id: string, originalName = `${id}.stl`): UploadedModelDto {
  return {
    id,
    originalName,
    format: "stl",
    sizeBytes: 84,
    bboxMm: { x: 10, y: 20, z: 30 },
    volumeCm3: 1,
    triangleCount: 1,
    fitsBed: true,
  };
}

beforeEach(() => {
  useQuoteStore.setState({ models: [], slices: {}, shipping: null });
});

describe("queued upload state", () => {
  it("moves through ticket-fenced queued and processing states", () => {
    const store = useQuoteStore.getState();
    store.addUploading("client-1", "part.stl", 84);
    store.markQueued("client-1", TICKET, 2);

    expect(useQuoteStore.getState().models[0]).toMatchObject({
      status: "queued",
      progress: 1,
      ticket: TICKET,
      modelsAhead: 2,
    });

    store.markProcessing("client-1", "wrong-ticket");
    expect(useQuoteStore.getState().models[0]!.status).toBe("queued");

    store.markProcessing("client-1", TICKET);
    expect(useQuoteStore.getState().models[0]).toMatchObject({
      status: "processing",
      ticket: TICKET,
    });

    // BullMQ can put a stalled active job back in the waiting list.
    store.markQueued("client-1", TICKET, 0, false);
    expect(useQuoteStore.getState().models[0]).toMatchObject({
      status: "queued",
      modelsAhead: 0,
      processorOnline: false,
    });
  });

  it("ignores stale terminal responses from another ticket", () => {
    const store = useQuoteStore.getState();
    store.addUploading("client-1", "part.stl", 84);
    store.markQueued("client-1", TICKET, 0);

    store.markError("client-1", "stale failure", "wrong-ticket");
    store.markReadyMany(
      "client-1",
      [model("22222222-2222-4222-8222-222222222222")],
      "wrong-ticket",
    );

    expect(useQuoteStore.getState().models).toHaveLength(1);
    expect(useQuoteStore.getState().models[0]!.status).toBe("queued");
  });

  it("replaces one ticket with every unique multi-plate model", () => {
    const first = model("22222222-2222-4222-8222-222222222222", "plate-1.stl");
    const second = model("33333333-3333-4333-8333-333333333333", "plate-2.stl");
    const store = useQuoteStore.getState();
    store.addUploading("client-1", "project.3mf", 512);
    store.markQueued("client-1", TICKET, 0);

    // A server-model refresh may win the race with the final ticket poll.
    store.restoreModels([first]);
    store.markReadyMany("client-1", [first, second], TICKET);

    const ready = useQuoteStore.getState().models;
    expect(ready).toHaveLength(2);
    expect(new Set(ready.map((entry) => entry.server?.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(ready.every((entry) => entry.status === "ready" && !entry.ticket)).toBe(true);
  });

  it("invalidates a shipping estimate as soon as another upload starts", () => {
    const store = useQuoteStore.getState();
    store.setShipping({
      pincode: "781001",
      amountPaise: 10000,
      days: "2",
      token: "token",
      quoteKey: "10:10000",
    });

    store.addUploading("client-1", "part.stl", 84);

    expect(useQuoteStore.getState().shipping).toBeNull();
  });
});
