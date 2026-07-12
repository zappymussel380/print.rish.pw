/** Parse JSON from an external service without trusting it to return a small
 * body. Timeouts bound latency; this bound independently limits memory. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error("Upstream response exceeded its size limit");
  }
  if (!response.body) throw new Error("Upstream returned an empty response");

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Upstream response exceeded its size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}
