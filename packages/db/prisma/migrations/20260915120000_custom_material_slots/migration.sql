-- The shop's own materials: four slots an owner names and gives an OrcaSlicer
-- profile in the admin dashboard (ABS-CF, PC, PA…). They ship disabled and are
-- only offered once named and profiled. Purely additive; enum order matches
-- schema.prisma.
ALTER TYPE "MaterialId" ADD VALUE 'OTHER_1' AFTER 'ASA';
ALTER TYPE "MaterialId" ADD VALUE 'OTHER_2' AFTER 'OTHER_1';
ALTER TYPE "MaterialId" ADD VALUE 'OTHER_3' AFTER 'OTHER_2';
ALTER TYPE "MaterialId" ADD VALUE 'OTHER_4' AFTER 'OTHER_3';
