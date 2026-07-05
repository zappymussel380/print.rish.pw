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
