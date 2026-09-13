-- Advanced mode: OrcaSlicer presets uploaded by the owner, test-sliced by the
-- worker before going live. Purely additive; unused unless ADVANCED_PROFILES=1.

-- CreateEnum
CREATE TYPE "SlicerProfileStatus" AS ENUM ('PENDING', 'TESTING', 'ACTIVE', 'FAILED', 'SKIPPED', 'RETIRED');

-- CreateTable
CREATE TABLE "SlicerProfileUpload" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "slot" TEXT,
    "originalName" TEXT NOT NULL,
    "presetName" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "flattened" JSONB,
    "meta" JSONB,
    "status" "SlicerProfileStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "testGrams" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "SlicerProfileUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlicerProfileUpload_status_slot_idx" ON "SlicerProfileUpload"("status", "slot");

-- CreateIndex
CREATE INDEX "SlicerProfileUpload_batchId_idx" ON "SlicerProfileUpload"("batchId");
