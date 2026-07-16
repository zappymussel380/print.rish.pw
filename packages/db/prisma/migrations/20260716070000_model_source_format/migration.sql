-- STEP uploads are tessellated to STL at ingest; the original CAD file is
-- kept beside the stored mesh and recorded here (e.g. "step").
ALTER TABLE "UploadedModel"
ADD COLUMN "sourceFormat" TEXT;
