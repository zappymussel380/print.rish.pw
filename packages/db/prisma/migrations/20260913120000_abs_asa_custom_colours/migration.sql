-- ABS and ASA tiers (admin-defined colours only, shipped disabled), and the
-- colour name snapshot that keeps a deleted custom colour readable on old
-- quotations. Purely additive; enum order matches schema.prisma.
ALTER TYPE "MaterialId" ADD VALUE 'ABS' AFTER 'PETG_PREMIUM';
ALTER TYPE "MaterialId" ADD VALUE 'ASA' AFTER 'ABS';

ALTER TABLE "QuotationItem" ADD COLUMN "colourName" TEXT;
