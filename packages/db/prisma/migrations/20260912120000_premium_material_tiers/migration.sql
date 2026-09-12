-- Premium filament tiers, each with its own per-gram rate and slicer profile:
-- aesthetic PLA (matte/silk/metallic/...), PLA-CF, and translucent/CF PETG.
-- Purely additive; placed so the type's order matches schema.prisma.
ALTER TYPE "MaterialId" ADD VALUE 'PLA_AESTHETIC' AFTER 'PLA';
ALTER TYPE "MaterialId" ADD VALUE 'PLA_CF' AFTER 'PLA_AESTHETIC';
ALTER TYPE "MaterialId" ADD VALUE 'PETG_PREMIUM' AFTER 'PETG';
