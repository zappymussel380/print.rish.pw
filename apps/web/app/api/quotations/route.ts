import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { Prisma, prisma } from "@print/db";
import {
  CATALOG,
  customerSchema,
  estimateCompletionDate,
  modelConfigSchema,
  priceQuote,
  type QuoteLineInput,
  settingsKey,
  summariseItems,
} from "@print/shared";
import { guardMutation, jsonError } from "@/lib/api-util";
import { logger } from "@/lib/logger";
import { renderQuotationPdf } from "@/lib/pdf/quotation-pdf";
import { nextQuotationNumber } from "@/lib/quotation-number";
import { RATE_LIMITS } from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";
import { verifyEstimateToken } from "@/lib/shipping";
import { siteConfig, whatsappChatUrl } from "@/lib/site-config";
import { ensureStorageDirs, pdfPath } from "@/lib/storage";
import { buildWhatsAppUrl } from "@print/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORT_ENUM = { auto: "AUTO", off: "OFF", always: "ALWAYS" } as const;

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "checkout", RATE_LIMITS.checkout);
  if (guard) return guard;

  const sessionId = await getQuoteSessionId();
  if (!sessionId) return jsonError(401, "NO_SESSION", "No quote session");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "BAD_JSON", "Request body must be JSON");
  }

  const customer = customerSchema.safeParse((body as { customer?: unknown })?.customer);
  if (!customer.success) {
    return jsonError(422, "INVALID_CUSTOMER", "Please check your contact details", {
      issues: customer.error.flatten().fieldErrors,
    });
  }

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return jsonError(422, "NO_ITEMS", "Your quote has no models");
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

  for (const raw of rawItems) {
    const modelId = (raw as { modelId?: unknown })?.modelId;
    const config = modelConfigSchema.safeParse((raw as { config?: unknown })?.config);
    if (typeof modelId !== "string" || !config.success) {
      return jsonError(422, "BAD_ITEM", "A model in your quote has invalid settings");
    }

    const model = await prisma.uploadedModel.findFirst({ where: { id: modelId, sessionId } });
    if (!model) return jsonError(404, "MODEL_NOT_FOUND", "A model in your quote was not found");

    const slice = await prisma.sliceResult.findUnique({
      where: {
        fileHash_settingsKey: { fileHash: model.fileHash, settingsKey: settingsKey(config.data) },
      },
    });
    if (!slice || slice.status !== "DONE" || slice.filamentGrams == null) {
      return jsonError(409, "NOT_SLICED", `"${model.originalName}" still needs slicing`);
    }

    entries.push({
      modelId: model.id,
      sliceResultId: slice.id,
      fileName: model.originalName,
      config: config.data,
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
  const accessToken = randomBytes(32).toString("hex");

  // Optional prepaid shipping. The client sends the signed estimate token it got
  // when the customer viewed shipping on the quote page. We honour that exact
  // shown amount (never a fresh re-price, which could silently move) only if the
  // token verifies AND its bound parcel dimensions still match this rebuilt quote
  // — otherwise the estimate is stale/changed and we 409 so the user re-estimates
  // and sees the new figure before committing. No token → no shipping line.
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

  const created = await prisma.$transaction(async (tx) => {
    const number = await nextQuotationNumber(tx);
    return tx.quotation.create({
      data: {
        number,
        accessToken,
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
          shipping: shippingPaise > 0 ? { pincode: shippingPincode, amountPaise: shippingPaise, days: shippingDays } : null,
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

  // PDF rendering happens outside the transaction (it is CPU-bound and slow).
  try {
    await ensureStorageDirs();
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
    });
    const path = pdfPath(created.number);
    await writeFile(path, pdf);
    await prisma.quotation.update({ where: { id: created.id }, data: { pdfPath: path } });
  } catch {
    // A missing PDF should not lose the quotation; it can be regenerated.
  }

  logger.info(
    { number: created.number, items: entries.length, totalPaise: grandTotalPaise, shippingPaise },
    "quotation created",
  );

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
        notes: customer.data.notes,
      })
    : whatsappChatUrl();

  return NextResponse.json(
    {
      number: created.number,
      accessToken,
      pdfUrl: `/api/quotations/${created.number}/pdf?token=${accessToken}`,
      whatsappUrl,
    },
    { status: 201 },
  );
}
