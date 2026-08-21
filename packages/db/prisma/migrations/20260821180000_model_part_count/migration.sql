-- A multi-part 3MF is split into its build items and packed onto our own
-- plates at ingest, so every part is sliced and priced. Record how many parts
-- a stored mesh holds, so the quote can say what it covers after a reload.
ALTER TABLE "UploadedModel"
ADD COLUMN "partCount" INTEGER;
