import { writeFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma, prisma, type Quotation } from "@print/db";
import {
  CATALOG,
  customerSchema,
  estimateCompletionDate,
  modelConfigSchema,
  priceQuote,
  type QuoteLineInput,
  sliceArtifactKey,
  summariseItems,
} from "@print/shared";
import { guardMutation, jsonError, readJsonBody } from "@/lib/api-util";
import { env } from "@/lib/env";
import { logger, safeErrorMessage } from "@/lib/logger";
import { normalizeModelConfigLocks } from "@/lib/model-config-locks";
import { buildAnnexure } from "@/lib/pdf/annexure-data";
import { renderQuotationPdf } from "@/lib/pdf/quotation-pdf";
import { readThumbPng } from "@/lib/thumbs";
import { nextQuotationNumber } from "@/lib/quotation-number";
import { issueQuotationAccess, setQuotationAccessCookie } from "@/lib/quotation-access";
import {
  RATE_LIMITS,
  releaseRateLimitReservation,
  reserveRateLimit,
  withRedisLock,
} from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";
import { verifyEstimateToken } from "@/lib/shipping";
import { siteConfig, whatsappChatUrl } from "@/lib/site-config";
import {
  ensureStorageDirs,
  hasPdfStorageHeadroom,
  pdfPath,
  removeQuietly,
} from "@/lib/storage";
import { notifyNewQuotation, sendOperatorAlert } from "@/lib/telegram";
import { buildWhatsAppUrl } from "@print/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORT_ENUM = { auto: "AUTO", off: "OFF", always: "ALWAYS" } as const;

// The body is small: customer details (notes ≤ 2000 chars) plus up to
// maxModelsPerSession `{modelId,config}` refs and a shipping token. Anything
// materially larger is abuse, so reject by Content-Length before reading it
// (32 KiB is generous headroom for the real payload — mirrors /api/shipping).
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

class CheckoutConflictError extends Error {}

async function postQuotation(request: NextRequest) {
  const guard = await guardMutation(request, "checkout", RATE_LIMITS.checkout);
  if (guard) return guard;

  const sessionId = await getQuoteSessionId();
  if (!sessionId) return jsonError(401, "NO_SESSION", "No quote session");

  // Reject oversized bodies before parsing so even a single in-budget request
  // can't stream a huge payload at the parser.
  const parsedBody = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;

  const customer = customerSchema.safeParse((body as { customer?: unknown })?.customer);
  if (!customer.success) {
    return jsonError(422, "INVALID_CUSTOMER", "Please check your contact details", {
      issues: z.flattenError(customer.error).fieldErrors,
    });
  }

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return jsonError(422, "NO_ITEMS", "Your quote has no models");
  }
  if (rawItems.length > env.maxModelsPerSession) {
    return jsonError(
      422,
      "TOO_MANY_ITEMS",
      `A quote can contain at most ${env.maxModelsPerSession} models`,
    );
  }

  // Rebuild every line from authoritative DB state — client totals are never
  // trusted. A model must be session-owned and already sliced at its settings.
  const entries: {
    modelId: string;
    sliceResultId: string;
    fileName: string;
    config: ReturnType<typeof modelConfigSchema.parse>;
    stats: { filamentGrams: number; filamentMm: number; printSeconds: number; supportGrams: number | null };
  }[] = [];

  // One line per model — quantity handles multiples (matching the
  // quote UI). Duplicates are rejected rather than silently merged: this
  // becomes a financial document, so the server must never reinterpret what
  // the customer submitted. The legit client can't produce duplicates.
  const seenModels = new Set<string>();

  for (const raw of rawItems) {
    const modelId = (raw as { modelId?: unknown })?.modelId;
    const config = modelConfigSchema.safeParse((raw as { config?: unknown })?.config);
    if (typeof modelId !== "string" || !config.success) {
      return jsonError(422, "BAD_ITEM", "A model in your quote has invalid settings");
    }
    if (seenModels.has(modelId)) {
      return jsonError(422, "DUPLICATE_ITEM", "A model appears twice in your quote — use quantity instead");
    }
    seenModels.add(modelId);

    const model = await prisma.uploadedModel.findFirst({ where: { id: modelId, sessionId } });
    if (!model) return jsonError(404, "MODEL_NOT_FOUND", "A model in your quote was not found");
    if (model.submittedAt) {
      return jsonError(409, "MODEL_ALREADY_SUBMITTED", "A model in this quote was already submitted");
    }

    const normalizedConfig = normalizeModelConfigLocks(config.data, model);

    const slice = await prisma.sliceResult.findUnique({
      where: {
        fileHash_settingsKey: {
          fileHash: model.fileHash,
          settingsKey: sliceArtifactKey(
            model.format as "stl" | "3mf" | "obj" | "amf",
            normalizedConfig,
          ),
        },
      },
    });
    if (!slice || slice.status !== "DONE" || slice.filamentGrams == null) {
      return jsonError(409, "NOT_SLICED", `"${model.originalName}" still needs slicing`);
    }

    entries.push({
      modelId: model.id,
      sliceResultId: slice.id,
      fileName: model.originalName,
      config: normalizedConfig,
      stats: {
        filamentGrams: Number(slice.filamentGrams),
        filamentMm: slice.filamentMm != null ? Number(slice.filamentMm) : 0,
        printSeconds: slice.printSeconds ?? 0,
        supportGrams: slice.supportGrams != null ? Number(slice.supportGrams) : null,
      },
    });
  }

  const inputs: QuoteLineInput[] = entries.map((e) => ({
    modelId: e.modelId,
    config: e.config,
    stats: e.stats,
  }));

  let breakdown;
  try {
    breakdown = priceQuote(inputs, CATALOG);
  } catch {
    return jsonError(422, "PRICING_FAILED", "Could not price this quote");
  }
  const completion = estimateCompletionDate(breakdown.totals.printSeconds, CATALOG.leadTime);
  const access = issueQuotationAccess();

  // Optional prepaid shipping. The client sends the signed estimate token it got
  // when the customer viewed shipping on the quote page. We honour that exact
  // shown amount (never a fresh re-price, which could silently move) only if the
  // token verifies AND its bound parcel dimensions still match this rebuilt quote
  // — otherwise the estimate is stale/changed and we 409 so the user re-estimates
  // and sees the new figure before committing. No token → shipping is explicitly
  // EXCLUDED from the quotation (recorded in the snapshot and shown as "not
  // included" on the page/PDF), never a silent ₹0 delivery line.
  const shippingToken = (body as { shippingToken?: unknown })?.shippingToken;
  let shippingPaise = 0;
  let shippingPincode: string | null = null;
  let shippingDays: string | null = null;
  if (typeof shippingToken === "string" && shippingToken.length > 0) {
    const verified = await verifyEstimateToken(
      shippingToken,
      breakdown.totals.grams,
      breakdown.totalPaise,
    );
    if (!verified) {
      logger.warn("checkout blocked: shipping estimate token invalid/expired/mismatched");
      return jsonError(
        409,
        "SHIPPING_STALE",
        "Your shipping estimate expired or the quote changed. Please re-estimate shipping and try again.",
      );
    }
    shippingPaise = verified.amountPaise;
    shippingPincode = verified.pincode;
    shippingDays = verified.days;
  }
  const grandTotalPaise = breakdown.totalPaise + shippingPaise;

  const persistedIntegers = [
    breakdown.setupFeePaise,
    breakdown.totalPaise,
    shippingPaise,
    grandTotalPaise,
    ...breakdown.lines.flatMap((line) => [
      line.unitPrintSeconds,
      line.materialPaise,
      line.electricityPaise,
      line.maintenancePaise,
      line.subtotalPaise,
    ]),
  ];
  if (
    persistedIntegers.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 2_147_483_647,
    )
  ) {
    return jsonError(422, "QUOTE_TOO_LARGE", "This quotation exceeds supported numeric limits");
  }

  // Cross-IP circuit breaker is charged only after a session-owned, sliced,
  // priceable order has passed validation, so unauthenticated garbage cannot
  // cheaply consume the site's daily permanent-storage/notification capacity.
  const globalLimit = await reserveRateLimit(
    "checkout-global",
    "all",
    RATE_LIMITS.checkoutGlobal.max,
    RATE_LIMITS.checkoutGlobal.windowSeconds,
  );
  if (!globalLimit.allowed) {
    void sendOperatorAlert(
      "checkout_5xx",
      "Checkout daily capacity reached; new quotation requests are returning 503.",
    ).catch(() => {});
    const response = jsonError(
      503,
      "CHECKOUT_CAPACITY_REACHED",
      "Quotation capacity is temporarily full. Please try again later.",
    );
    response.headers.set("Retry-After", String(globalLimit.retryAfterSeconds));
    return response;
  }

  let created: Quotation;
  try {
    created = await prisma.$transaction(async (tx) => {
      // Claim every model in the same transaction as the quotation. This
      // conditional update is the cross-replica/concurrent replay boundary:
      // only one request can transition all rows to submitted.
      const claimed = await tx.uploadedModel.updateMany({
        where: {
          id: { in: entries.map((entry) => entry.modelId) },
          sessionId,
          submittedAt: null,
          items: { none: {} },
        },
        data: { submittedAt: new Date() },
      });
      if (claimed.count !== entries.length) throw new CheckoutConflictError();

      const number = await nextQuotationNumber(tx);
      return tx.quotation.create({
        data: {
          number,
          accessToken: access.verifier,
          accessTokenExpiresAt: access.expiresAt,
          status: "PENDING",
          customerName: customer.data.name,
          customerEmail: customer.data.email,
          customerPhone: customer.data.phone,
          customerCity: customer.data.city,
          notes: customer.data.notes ?? "",
          setupFeePaise: breakdown.setupFeePaise,
          totalPaise: grandTotalPaise,
          shippingPaise,
          shippingPincode,
          estimatedCompletion: completion,
          pricingSnapshot: {
            catalog: CATALOG,
            breakdown,
            shipping:
              shippingPaise > 0
                ? { pincode: shippingPincode, amountPaise: shippingPaise, days: shippingDays }
                : { excluded: true },
            generatedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
          items: {
            create: breakdown.lines.map((line, i) => {
              const e = entries[i]!;
              return {
                modelId: e.modelId,
                sliceResultId: e.sliceResultId,
                material: e.config.material,
                colour: e.config.colour,
                layerHeightUm: e.config.layerHeightUm,
                infillPct: e.config.infillPct,
                supports: SUPPORT_ENUM[e.config.supports],
                quantity: e.config.quantity,
                unitGrams: line.unitGrams,
                unitPrintSeconds: line.unitPrintSeconds,
                materialPaise: line.materialPaise,
                electricityPaise: line.electricityPaise,
                maintenancePaise: line.maintenancePaise,
                subtotalPaise: line.subtotalPaise,
              };
            }),
          },
          history: { create: { toStatus: "PENDING", note: "Quotation submitted" } },
        },
      });
    });
  } catch (err) {
    if (globalLimit.member) {
      await releaseRateLimitReservation("checkout-global", "all", globalLimit.member).catch(
        () => {},
      );
    }
    if (err instanceof CheckoutConflictError) {
      return jsonError(409, "MODEL_ALREADY_SUBMITTED", "This quote was already submitted");
    }
    throw err;
  }

  // PDF rendering happens outside the transaction (it is CPU-bound and slow).
  try {
    await ensureStorageDirs();
    // Annexure pages need geometry + slicer detail beyond what `entries`
    // retained; a missing row or thumbnail degrades that page, never the PDF.
    const modelRows = await prisma.uploadedModel.findMany({
      where: { id: { in: entries.map((e) => e.modelId) } },
    });
    const sliceRows = await prisma.sliceResult.findMany({
      where: { id: { in: entries.map((e) => e.sliceResultId) } },
    });
    const modelsById = new Map(modelRows.map((m) => [m.id, m]));
    const slicesById = new Map(sliceRows.map((r) => [r.id, r]));
    const annexures = (
      await Promise.all(
        breakdown.lines.map(async (line, i) => {
          const entry = entries[i]!;
          const model = modelsById.get(entry.modelId);
          const slice = slicesById.get(entry.sliceResultId);
          if (!model || !slice) return null;
          return buildAnnexure({
            fileName: entry.fileName,
            thumbnailPng: await readThumbPng(model.id, model.fileHash, model.thumbPath),
            model,
            slice,
            settings: {
              material: line.config.material,
              colour: line.config.colour,
              layerHeightUm: line.config.layerHeightUm,
              infillPct: line.config.infillPct,
              supports: line.config.supports,
              quantity: line.config.quantity,
            },
            pricing: {
              materialPaise: line.materialPaise,
              electricityPaise: line.electricityPaise,
              maintenancePaise: line.maintenancePaise,
              subtotalPaise: line.subtotalPaise,
            },
          });
        }),
      )
    ).filter((annexure) => annexure !== null);
    const pdf = await renderQuotationPdf({
      number: created.number,
      createdAt: created.createdAt,
      customer: {
        name: customer.data.name,
        email: customer.data.email,
        phone: customer.data.phone,
        city: customer.data.city,
        notes: customer.data.notes ?? "",
      },
      lines: breakdown.lines.map((line, i) => ({
        fileName: entries[i]!.fileName,
        material: line.config.material,
        colour: line.config.colour,
        layerHeightUm: line.config.layerHeightUm,
        infillPct: line.config.infillPct,
        supports: line.config.supports,
        quantity: line.config.quantity,
        totalGrams: line.totalGrams,
        totalPrintSeconds: line.totalPrintSeconds,
        subtotalPaise: line.subtotalPaise,
      })),
      setupFeePaise: breakdown.setupFeePaise,
      shippingPaise,
      totalPaise: grandTotalPaise,
      totalGrams: breakdown.totals.grams,
      totalPrintSeconds: breakdown.totals.printSeconds,
      completion,
      annexures,
    });
    if (pdf.length > MAX_PDF_BYTES) throw new Error("Generated quotation PDF exceeds the size limit");
    const path = pdfPath(created.number);
    const persisted = await withRedisLock(
      "pdf-write",
      async () => {
        if (!(await hasPdfStorageHeadroom(pdf.length + env.storageReserveBytes))) {
          throw new Error("Insufficient reserved capacity for quotation PDF");
        }
        await writeFile(path, pdf, { flag: "wx", mode: 0o600 });
        try {
          await prisma.quotation.update({ where: { id: created.id }, data: { pdfPath: path } });
        } catch (err) {
          await removeQuietly(path).catch(() => {});
          throw err;
        }
      },
      { leaseMs: 30_000, waitMs: 10_000 },
    );
    if (persisted === null) throw new Error("Quotation PDF storage is busy");
  } catch (err) {
    // A missing PDF should not lose the quotation; it can be regenerated.
    logger.warn({ error: safeErrorMessage(err) }, "quotation PDF generation failed");
    void sendOperatorAlert(
      "quotation_pdf_failure",
      "Quotation PDF generation failed; regeneration may be required.",
    ).catch(() => {});
  }

  logger.info(
    { number: created.number, items: entries.length, totalPaise: grandTotalPaise, shippingPaise },
    "quotation created",
  );

  await notifyNewQuotation({
    number: created.number,
    customer: {
      name: customer.data.name,
      email: customer.data.email,
      phone: customer.data.phone,
      city: customer.data.city,
      notes: customer.data.notes,
    },
    lines: breakdown.lines.map((line, i) => {
      const entry = entries[i]!;
      return {
        modelId: entry.modelId,
        fileName: entry.fileName,
        material: line.config.material,
        colour: line.config.colour,
        layerHeightUm: line.config.layerHeightUm,
        infillPct: line.config.infillPct,
        supports: line.config.supports,
        quantity: line.config.quantity,
        totalGrams: line.totalGrams,
        totalPrintSeconds: line.totalPrintSeconds,
        subtotalPaise: line.subtotalPaise,
      };
    }),
    totalPaise: grandTotalPaise,
    shippingPaise,
    shippingPincode,
  });

  const materialsSummary = summariseItems(
    entries.map((e) => ({ material: e.config.material, colour: e.config.colour, quantity: e.config.quantity })),
  );
  const whatsappUrl = siteConfig.whatsappNumber
    ? buildWhatsAppUrl({
        number: siteConfig.whatsappNumber,
        quotationNumber: created.number,
        customerName: customer.data.name,
        materialsSummary,
        totalPaise: grandTotalPaise,
        shippingPaise,
        shippingPincode,
        notes: customer.data.notes,
      })
    : whatsappChatUrl();

  const response = NextResponse.json(
    {
      number: created.number,
      accessToken: access.token,
      pdfUrl: `/api/quotations/${created.number}/pdf`,
      whatsappUrl,
    },
    { status: 201 },
  );
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  setQuotationAccessCookie(response, created.number, access.token, access.expiresAt);
  return response;
}

/**
 * Keep the alert boundary outside the checkout implementation so every
 * unexpected exception is reported without changing the error Next.js sees.
 * Expected customer-facing errors return responses from postQuotation and do
 * not cross this boundary.
 */
export async function POST(request: NextRequest) {
  try {
    return await postQuotation(request);
  } catch (err) {
    void sendOperatorAlert(
      "checkout_5xx",
      "Checkout failed before a response could be completed.",
    ).catch(() => {});
    throw err;
  }
}
