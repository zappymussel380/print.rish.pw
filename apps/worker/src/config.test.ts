import { describe, expect, it } from "vitest";
import { stubSlicerEnabled } from "./config";

describe("stubSlicerEnabled", () => {
  it("is disabled when the flag is absent or explicitly false", () => {
    expect(stubSlicerEnabled(undefined, "development")).toBe(false);
    expect(stubSlicerEnabled("false", "production")).toBe(false);
  });

  it("is available only in an explicitly development or test process", () => {
    expect(stubSlicerEnabled("true", "development")).toBe(true);
    expect(stubSlicerEnabled("true", "test")).toBe(true);
  });

  it("refuses the stub in production", () => {
    expect(() => stubSlicerEnabled("true", "production")).toThrow(/restricted/);
  });

  it("refuses the stub when NODE_ENV is unset", () => {
    const original = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(() => stubSlicerEnabled("true")).toThrow(/restricted/);
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it("rejects ambiguous flag values", () => {
    expect(() => stubSlicerEnabled("1", "test")).toThrow(/true or false/);
  });
});
