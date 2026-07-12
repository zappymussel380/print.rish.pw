ALTER TABLE "SliceResult"
ADD COLUMN "progressPct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "progressStage" TEXT NOT NULL DEFAULT 'queued',
ADD COLUMN "progressMessage" TEXT NOT NULL DEFAULT 'Waiting for a slicer',
ADD COLUMN "progressUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "SliceResult"
SET
  "progressPct" = CASE WHEN "status" = 'DONE' THEN 100 ELSE 0 END,
  "progressStage" = CASE
    WHEN "status" = 'DONE' THEN 'complete'
    WHEN "status" = 'FAILED' THEN 'failed'
    WHEN "status" = 'RUNNING' THEN 'preparing'
    ELSE 'queued'
  END,
  "progressMessage" = CASE
    WHEN "status" = 'DONE' THEN 'Quote data ready'
    WHEN "status" = 'FAILED' THEN 'Slicing failed'
    WHEN "status" = 'RUNNING' THEN 'Preparing model'
    ELSE 'Waiting for a slicer'
  END;
