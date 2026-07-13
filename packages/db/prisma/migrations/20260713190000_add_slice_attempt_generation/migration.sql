ALTER TABLE "SliceResult"
ADD COLUMN "attemptId" UUID;

UPDATE "SliceResult"
SET "attemptId" = gen_random_uuid();

ALTER TABLE "SliceResult"
ALTER COLUMN "attemptId" SET NOT NULL;
