-- Bound customer capability lifetime and replace stored bearer tokens with
-- one-way verifiers before the new application starts.
ALTER TABLE "Quotation" ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3);
UPDATE "Quotation"
SET "accessTokenExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '30 days'
WHERE "accessTokenExpiresAt" IS NULL;
UPDATE "Quotation"
SET "accessToken" = 'sha256:' || encode(sha256(convert_to("accessToken", 'UTF8')), 'hex')
WHERE "accessToken" NOT LIKE 'sha256:%';
ALTER TABLE "Quotation" ALTER COLUMN "accessTokenExpiresAt" SET NOT NULL;
