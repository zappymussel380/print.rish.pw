import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin, clientIp, rateLimit, type RATE_LIMITS } from "./security";

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

/** Reject a request whose declared body size exceeds `maxBytes`, BEFORE the body
 *  is read — so a route never buffers/parses an oversized payload. A chunked or
 *  absent Content-Length slips past (bounded elsewhere by rate limits / the
 *  proxy); this is the cheap first line. Returns a 413 to short-circuit, or null
 *  to proceed. */
export function assertBodySize(request: NextRequest, maxBytes: number): NextResponse | null {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    return jsonError(413, "BODY_TOO_LARGE", "Request body too large.");
  }
  return null;
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
