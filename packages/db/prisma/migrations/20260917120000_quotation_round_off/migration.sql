-- What rounding the grand total to a whole rupee added (−50…+49 paise),
-- frozen at submission and already inside totalPaise. Additive: existing
-- quotations read as no round off, their totals untouched.
ALTER TABLE "Quotation" ADD COLUMN "roundOffPaise" INTEGER NOT NULL DEFAULT 0;
