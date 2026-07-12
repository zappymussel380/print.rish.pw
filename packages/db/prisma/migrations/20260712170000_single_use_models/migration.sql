ALTER TABLE "UploadedModel" ADD COLUMN "submittedAt" TIMESTAMP(3);

-- Preserve historical quotations while marking every already-attached model
-- as consumed. Legacy data may contain more than one quotation per model; the
-- earliest submission timestamp is sufficient for the single-use boundary.
UPDATE "UploadedModel" AS model
SET "submittedAt" = attached."submittedAt"
FROM (
  SELECT item."modelId", MIN(quotation."createdAt") AS "submittedAt"
  FROM "QuotationItem" AS item
  JOIN "Quotation" AS quotation ON quotation."id" = item."quotationId"
  GROUP BY item."modelId"
) AS attached
WHERE model."id" = attached."modelId";
