import { describe, expect, it } from "vitest";
import {
  ingestJobDataSchema,
  ingestJobResultSchema,
  publicIngestFailure,
} from "./ingest-job";

const jobData = {
  tmpName: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  originalName: "part.stl",
  format: "stl",
  sizeBytes: 84,
  sha256: "a".repeat(64),
  reservationMember: "1024:33333333-3333-4333-8333-333333333333",
};

describe("ingest queue contracts", () => {
  it("accepts only server-derived queue identities", () => {
    expect(ingestJobDataSchema.parse(jobData)).toEqual(jobData);
    expect(
      ingestJobDataSchema.safeParse({ ...jobData, tmpName: "../customer.stl" }).success,
    ).toBe(false);
    expect(
      ingestJobDataSchema.safeParse({ ...jobData, sha256: "not-a-hash" }).success,
    ).toBe(false);
    expect(
      ingestJobDataSchema.safeParse({
        ...jobData,
        tmpName: "11111111-1111-6111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      ingestJobDataSchema.safeParse({
        ...jobData,
        tmpName: "11111111-1111-4111-7111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      ingestJobDataSchema.safeParse({ ...jobData, unexpectedPath: "/data/uploads/tmp/x" }).success,
    ).toBe(false);
  });

  it("bounds customer-visible worker failures", () => {
    expect(publicIngestFailure("INVALID_MODEL_EMPTY", "The model is empty")).toEqual({
      code: "INVALID_MODEL_EMPTY",
      message: "The model is empty",
    });
    expect(() => publicIngestFailure("bad-code", "nope")).toThrow();
    expect(() => publicIngestFailure("INGEST_FAILED", "x".repeat(501))).toThrow();
  });

  it("rejects malformed worker return values before they reach a poller", () => {
    const model = {
      id: "44444444-4444-4444-8444-444444444444",
      originalName: "part.stl",
      format: "stl",
      sizeBytes: 84,
      bboxMm: { x: 20, y: 20, z: 20 },
      volumeCm3: 8,
      triangleCount: 12,
      fitsBed: true,
    };
    expect(ingestJobResultSchema.parse({ model, models: [model] })).toEqual({
      model,
      models: [model],
    });
    expect(ingestJobResultSchema.safeParse({ model, models: [] }).success).toBe(false);
    expect(
      ingestJobResultSchema.safeParse({ model: { ...model, storedPath: "/secret" }, models: [model] })
        .success,
    ).toBe(false);
  });
});
