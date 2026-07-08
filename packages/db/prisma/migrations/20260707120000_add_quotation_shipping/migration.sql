-- Add prepaid shipping fields to Quotation. shippingPaise is included in
-- totalPaise (grand total); kept separate so the PDF/view can show a line.
ALTER TABLE "Quotation" ADD COLUMN "shippingPaise" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Quotation" ADD COLUMN "shippingPincode" TEXT;
