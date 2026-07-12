import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin, clientIp, rateLimit, type RATE_LIMITS } from "./security";
import { isAdmin } from "./session";

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

/** Route-level admin check. Middleware remains the fast UI gate, but sensitive
 * APIs do not rely on middleware matching as their sole authorization layer. */
export async function requireAdminApi(): Promise<NextResponse | null> {
  return (await isAdmin())
    ? null
    : jsonError(401, "UNAUTHENTICATED", "Admin login required");
}

/** Reject a request whose declared body size exceeds `maxBytes`, before the body
 * is read. Chunked or absent Content-Length is handled by `readJsonBody`; this
 * remains the cheap first line. Returns a 413 to short-circuit, or null. */
export function assertBodySize(request: NextRequest, maxBytes: number): NextResponse | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    return jsonError(400, "BAD_CONTENT_LENGTH", "Invalid Content-Length header.");
  }
  const declared = Number(normalized);
  if (!Number.isSafeInteger(declared)) {
    return jsonError(400, "BAD_CONTENT_LENGTH", "Invalid Content-Length header.");
  }
  if (declared > maxBytes) {
    return jsonError(413, "BODY_TOO_LARGE", "Request body too large.");
  }
  return null;
}

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: NextResponse };

/** Read and parse a JSON request with an enforced byte ceiling even when the
 * caller uses chunked transfer encoding or omits Content-Length. Route handlers
 * must not use request.json() for attacker-controlled bodies: the proxy's large
 * upload allowance otherwise lets a tiny JSON endpoint buffer hundreds of MiB. */
export async function readJsonBody(
  request: NextRequest,
  maxBytes: number,
): Promise<JsonBodyResult> {
  const declaredError = assertBodySize(request, maxBytes);
  if (declaredError) return { ok: false, response: declaredError };
  if (!request.body) {
    return { ok: false, response: jsonError(400, "BAD_JSON", "Request body must be JSON") };
  }

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          response: jsonError(413, "BODY_TOO_LARGE", "Request body too large."),
        };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { ok: false, response: jsonError(400, "BAD_JSON", "Request body must be JSON") };
  } finally {
    reader.releaseLock();
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks, total).toString("utf8")) };
  } catch {
    return { ok: false, response: jsonError(400, "BAD_JSON", "Request body must be JSON") };
  }
}

/** Shared preamble for mutating endpoints: CSRF origin check + rate limit.
 *  Returns a response to short-circuit with, or null to proceed. */
export async function guardMutation(
  request: NextRequest,
  bucket: keyof typeof RATE_LIMITS,
  limits: { max: number; windowSeconds: number },
): Promise<NextResponse | null> {
  if (!assertSameOrigin(request)) {
    return jsonError(403, "CSRF", "Cross-origin request rejected");
  }
  const result = await rateLimit(bucket, clientIp(request), limits.max, limits.windowSeconds);
  if (!result.allowed) {
    const response = jsonError(429, "RATE_LIMITED", "Too many requests — please slow down", {
      retryAfterSeconds: result.retryAfterSeconds,
    });
    response.headers.set("Retry-After", String(result.retryAfterSeconds));
    return response;
  }
  return null;
}
