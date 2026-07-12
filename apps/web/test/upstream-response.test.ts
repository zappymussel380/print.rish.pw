import { describe, expect, it } from "vitest";
import { readBoundedJson } from "@/lib/upstream-response";

describe("bounded upstream JSON", () => {
  it("parses a response inside the byte ceiling", async () => {
    await expect(readBoundedJson(new Response('{"ok":true}'), 32)).resolves.toEqual({ ok: true });
  });

  it("rejects declared and streamed oversized responses", async () => {
    await expect(
      readBoundedJson(new Response("{}", { headers: { "content-length": "100" } }), 16),
    ).rejects.toThrow(/size limit/);
    await expect(readBoundedJson(new Response(`{"x":"${"a".repeat(32)}"}`), 16)).rejects.toThrow(
      /size limit/,
    );
  });
});
