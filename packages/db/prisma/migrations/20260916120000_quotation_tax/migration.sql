-- GST the shop added to a quotation (admin → Settings → GST), frozen at
-- submission. Additive: existing quotations read as no tax.
ALTER TABLE "Quotation" ADD COLUMN "taxPaise" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Quotation" ADD COLUMN "taxRateBp" INTEGER;
ALTER TABLE "Quotation" ADD COLUMN "taxHsn" TEXT;
ALTER TABLE "Quotation" ADD COLUMN "taxGstin" TEXT;
