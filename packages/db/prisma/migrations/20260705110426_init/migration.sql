-- CreateEnum
CREATE TYPE "MaterialId" AS ENUM ('PLA', 'PETG');

-- CreateEnum
CREATE TYPE "SupportMode" AS ENUM ('AUTO', 'OFF', 'ALWAYS');

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('PENDING', 'QUOTED', 'APPROVED', 'PRINTING', 'COMPLETED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SliceStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "UploadedModel" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "fileHash" CHAR(64) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "bboxXMm" DOUBLE PRECISION,
    "bboxYMm" DOUBLE PRECISION,
    "bboxZMm" DOUBLE PRECISION,
    "volumeCm3" DOUBLE PRECISION,
    "thumbPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SliceResult" (
    "id" UUID NOT NULL,
    "fileHash" CHAR(64) NOT NULL,
    "settingsKey" TEXT NOT NULL,
    "settingsJson" JSONB NOT NULL,
    "status" "SliceStatus" NOT NULL DEFAULT 'QUEUED',
    "filamentGrams" DECIMAL(10,3),
    "filamentMm" DECIMAL(12,1),
    "printSeconds" INTEGER,
    "supportGrams" DECIMAL(10,3),
    "slicerVersion" TEXT NOT NULL,
    "rawMeta" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SliceResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quotation" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'PENDING',
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerCity" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "setupFeePaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "pdfPath" TEXT,
    "accessToken" TEXT NOT NULL,
    "estimatedCompletion" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotationItem" (
    "id" UUID NOT NULL,
    "quotationId" UUID NOT NULL,
    "modelId" UUID NOT NULL,
    "sliceResultId" UUID NOT NULL,
    "material" "MaterialId" NOT NULL,
    "colour" TEXT NOT NULL,
    "layerHeightUm" INTEGER NOT NULL,
    "infillPct" INTEGER NOT NULL,
    "supports" "SupportMode" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitGrams" DECIMAL(10,3) NOT NULL,
    "unitPrintSeconds" INTEGER NOT NULL,
    "materialPaise" INTEGER NOT NULL,
    "electricityPaise" INTEGER NOT NULL,
    "maintenancePaise" INTEGER NOT NULL,
    "subtotalPaise" INTEGER NOT NULL,

    CONSTRAINT "QuotationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusHistory" (
    "id" UUID NOT NULL,
    "quotationId" UUID NOT NULL,
    "fromStatus" "QuotationStatus",
    "toStatus" "QuotationStatus" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotationCounter" (
    "year" INTEGER NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuotationCounter_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE INDEX "UploadedModel_fileHash_idx" ON "UploadedModel"("fileHash");

-- CreateIndex
CREATE INDEX "UploadedModel_sessionId_idx" ON "UploadedModel"("sessionId");

-- CreateIndex
CREATE INDEX "UploadedModel_createdAt_idx" ON "UploadedModel"("createdAt");

-- CreateIndex
CREATE INDEX "SliceResult_status_idx" ON "SliceResult"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SliceResult_fileHash_settingsKey_key" ON "SliceResult"("fileHash", "settingsKey");

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_number_key" ON "Quotation"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_accessToken_key" ON "Quotation"("accessToken");

-- CreateIndex
CREATE INDEX "Quotation_status_idx" ON "Quotation"("status");

-- CreateIndex
CREATE INDEX "Quotation_createdAt_idx" ON "Quotation"("createdAt");

-- CreateIndex
CREATE INDEX "Quotation_customerEmail_idx" ON "Quotation"("customerEmail");

-- CreateIndex
CREATE INDEX "QuotationItem_quotationId_idx" ON "QuotationItem"("quotationId");

-- CreateIndex
CREATE INDEX "StatusHistory_quotationId_idx" ON "StatusHistory"("quotationId");

-- AddForeignKey
ALTER TABLE "QuotationItem" ADD CONSTRAINT "QuotationItem_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationItem" ADD CONSTRAINT "QuotationItem_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "UploadedModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationItem" ADD CONSTRAINT "QuotationItem_sliceResultId_fkey" FOREIGN KEY ("sliceResultId") REFERENCES "SliceResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusHistory" ADD CONSTRAINT "StatusHistory_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
