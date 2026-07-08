import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import {
  CATALOG,
  modelConfigSchema,
  priceQuote,
  type QuoteLineInput,
  settingsKey,
} from "@print/shared";
import { assertBodySize, jsonError } from "@/lib/api-util";
import { env } from "@/lib/env";
import { assertSameOrigin, clientIp, rateLimit, RATE_LIMITS } from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";
import {
  billedWeightKg,
  fetchShipping,
  getCachedShipping,
  issueEstimateToken,
  MAX_WEIGHT_KG,
  type ShippingReason,
} from "@/lib/shipping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PINCODE_RE = /^\d{6}$/;

// The body is tiny: a pincode plus up to maxModelsPerSession `{modelId,config}`
// refs. Anything materially larger is abuse, so reject by Content-Length before
// reading it (32 KiB is generous headroom for the real payload).
const MAX_BODY_BYTES = 32 * 1024;

/** Map a shared-estimator failure reason to an HTTP error response. */
function reasonError(reason: ShippingReason) {
  switch (reason) {
    case "TOO_HEAVY":
      return jsonError(422, "TOO_HEAVY", "This parcel is too heavy for an instant estimate — we'll confirm shipping over WhatsApp.");
    case "NOT_CONFIGURED":
      return jsonError(500, "NOT_CONFIGURED", "Shipping estimates are not configured yet.");
    case "NO_SERVICE":
      return jsonError(404, "NO_SERVICE", "We can't ship to that pincode right now.");
    case "BUSY":
      return jsonError(503, "BUSY", "Shipping estimates are paused for now. Please try again later.");
    default:
      return jsonError(502, "UPSTREAM", "Couldn't estimate shipping right now. Please try again later.");
  }
}

interface RebuildResult {
  grams: number;
  totalPaise: number;
}

/** Rebuild the quote's authoritative weight + declared value from DB state —
 *  exactly like the quotations route. Client-supplied totals are never trusted:
 *  every item must reference a session-owned model with a DONE slice at its
 *  settings, and weight/value come from those slice results via priceQuote.
 *  Returns null when nothing valid was supplied (which also serves as the
 *  anti-abuse gate: you must have really uploaded + sliced to get here). */
async function rebuildTotals(
  items: unknown,
  sessionId: string,
  maxItems: number,
): Promise<RebuildResult | null> {
  if (!Array.isArray(items) || items.length === 0 || items.length > maxItems) return null;

  // Parse + dedupe first (no DB): a quote never has two identical lines, and
  // this caps the number of lookups at the distinct line count regardless of
  // how many duplicates a caller stuffs in.
  const lines = new Map<string, ReturnType<typeof modelConfigSchema.parse> & { modelId: string }>();
  for (const raw of items) {
    const modelId = (raw as { modelId?: unknown })?.modelId;
    const config = modelConfigSchema.safeParse((raw as { config?: unknown })?.config);
    if (typeof modelId !== "string" || !config.success) return null;
    lines.set(`${modelId}::${settingsKey(config.data)}`, { ...config.data, modelId });
  }

  const inputs: QuoteLineInput[] = [];
  for (const line of lines.values()) {
    const { modelId, ...config } = line;
    const model = await prisma.uploadedModel.findFirst({ where: { id: modelId, sessionId } });
    if (!model) return null;

    const slice = await prisma.sliceResult.findUnique({
      where: {
        fileHash_settingsKey: { fileHash: model.fileHash, settingsKey: settingsKey(config) },
      },
    });
    if (!slice || slice.status !== "DONE" || slice.filamentGrams == null) return null;

    inputs.push({
      modelId: model.id,
      config,
      stats: {
        filamentGrams: Number(slice.filamentGrams),
        filamentMm: slice.filamentMm != null ? Number(slice.filamentMm) : 0,
        printSeconds: slice.printSeconds ?? 0,
        supportGrams: slice.supportGrams != null ? Number(slice.supportGrams) : null,
      },
    });
  }

  if (inputs.length === 0) return null;
  const breakdown = priceQuote(inputs, CATALOG);
  return { grams: breakdown.totals.grams, totalPaise: breakdown.totalPaise };
}

export async function POST(request: NextRequest) {
  // CSRF guard always applies (rate limiting only on cache miss, below).
  if (!assertSameOrigin(request)) {
    return jsonError(403, "CSRF", "Cross-origin request rejected");
  }

  // Authorise and rate-limit BEFORE reading the body: these are cheap (a cookie
  // verify + one Redis op) and must gate the request so an unauthenticated or
  // over-limit caller can never push us into parsing an arbitrary JSON payload.
  const sessionId = await getQuoteSessionId();
  if (!sessionId) return jsonError(401, "NO_SESSION", "Start a quote first.");

  // Coarse frequency gate, also ahead of any DB work so the endpoint can't be
  // used as a database-saturation target. Generous for real use.
  const reqRl = await rateLimit(
    "shippingRequest",
    `${clientIp(request)}:${sessionId}`,
    RATE_LIMITS.shippingRequest.max,
    RATE_LIMITS.shippingRequest.windowSeconds,
  );
  if (!reqRl.allowed) {
    const res = jsonError(429, "RATE_LIMITED", "Too many shipping checks. Please try again shortly.", {
      retryAfterSeconds: reqRl.retryAfterSeconds,
    });
    res.headers.set("Retry-After", String(reqRl.retryAfterSeconds));
    return res;
  }

  // Reject oversized bodies before parsing so even a single in-budget request
  // can't stream a huge payload at the parser.
  const tooLarge = assertBodySize(request, MAX_BODY_BYTES);
  if (tooLarge) return tooLarge;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "BAD_JSON", "Request body must be JSON");
  }
  const raw = body as Record<string, unknown>;

  const deliveryPincode = String(raw.deliveryPincode ?? "").trim();
  if (!PINCODE_RE.test(deliveryPincode)) {
    return jsonError(400, "BAD_PINCODE", "Enter a valid 6-digit pincode.");
  }

  // Weight + declared value are rebuilt from authoritative DB state — never from
  // the request. This also gates abuse: you must own real sliced models to get
  // a non-null result. Item count is capped + deduped to bound the DB work.
  const totals = await rebuildTotals(raw.items, sessionId, env.maxModelsPerSession);
  if (!totals) {
    return jsonError(403, "NO_SLICE", "Add and price a model before estimating shipping.");
  }

  if (billedWeightKg(totals.grams) > MAX_WEIGHT_KG) {
    return reasonError("TOO_HEAVY");
  }

  const input = {
    deliveryPincode,
    weightGrams: totals.grams,
    declaredValuePaise: totals.totalPaise,
  };

  // Cache hit → serve free, without consuming the per-client upstream budget.
  const cached = await getCachedShipping(input);
  if (cached) {
    const token = await issueEstimateToken(input, cached);
    return NextResponse.json({
      estimate: { amountPaise: cached.amountPaise, days: cached.days, token },
      weightKg: cached.weightKg,
    });
  }

  // Cache miss → this will hit the paid API, so rate-limit per IP + browser.
  const rl = await rateLimit(
    "shipping",
    `${clientIp(request)}:${sessionId}`,
    RATE_LIMITS.shipping.max,
    RATE_LIMITS.shipping.windowSeconds,
  );
  if (!rl.allowed) {
    const res = jsonError(429, "RATE_LIMITED", "You've checked a few pincodes already. Please try again shortly.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
    res.headers.set("Retry-After", String(rl.retryAfterSeconds));
    return res;
  }

  const result = await fetchShipping(input);
  if (!result.ok) return reasonError(result.reason);
  const token = await issueEstimateToken(input, result.estimate);
  return NextResponse.json({
    estimate: { amountPaise: result.estimate.amountPaise, days: result.estimate.days, token },
    weightKg: result.estimate.weightKg,
  });
}
