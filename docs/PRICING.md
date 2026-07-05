# Pricing

The pricing engine ([`packages/shared/src/pricing.ts`](../packages/shared/src/pricing.ts))
is **pure, isomorphic and config-driven**. The same function reprices live on the
client and authoritatively on the server at checkout — the client total is never
trusted.

## The formula

For each model line:

```
totalGrams        = slicerGrams × quantity
lineCharge        = round(totalGrams × material.sellPerGramPaise)   ← what the customer pays
```

Grand total:

```
total = Σ lineCharge + setupFee          (one setup fee per order, any file count)
```

All arithmetic is in **integer paise**, rounded half-up at the line level.

## Informational components (never added on top)

The per-gram rate already covers these; they're shown for transparency only:

- **Filament cost** — `totalGrams / 1000 × material.costPerKgPaise`
- **Electricity** — `printHours × printer.kwhPerHour × electricityPerKwhPaise`
- **Maintenance** — `totalGrams × maintenancePerGramPaise`

They are computed and displayed as "included in the rate", but the customer total
is strictly `Σ material charge + setup fee`.

## Estimated completion

```
printDays = ceil(totalPrintSeconds / 3600 / leadTime.printHoursPerDay)
ready     = today + max(printDays, 1) + leadTime.bufferDays
```

## The catalog

All rates live in [`packages/shared/src/catalog.ts`](../packages/shared/src/catalog.ts)
as the `CATALOG` constant. Current values:

| Item | Value |
| --- | --- |
| Setup fee | ₹150 / order |
| PLA sell | ₹2.00 / g (cost ₹600/kg, density 1.26) |
| PETG sell | ₹2.50 / g (cost ₹800/kg, density 1.27) |
| Electricity | ₹10 / kWh × 0.09 kWh per print-hour |
| Maintenance | ₹0.20 / g |
| Lead time | 8 print-hours/day + 2 buffer days |
| Bed | 256 × 256 × 256 mm (Bambu Lab A1) |

## Changing prices

Edit `CATALOG` and rebuild. Because the catalog is passed into the engine as a
parameter, nothing else changes. Existing quotations are unaffected — each stores
its full catalog + breakdown in `pricingSnapshot` at submission time, so a price
change never rewrites history.

Unit tests in `packages/shared/src/pricing.test.ts` assert rounding, quantity
multiplication, both materials, and that the breakdown components sum to the
total — run `pnpm --filter @print/shared test` after any change.

## Future: DB-backed catalog

The engine already takes the catalog as an argument. To make prices editable at
runtime, load a catalog row from the DB and pass it in — no engine refactor
needed.
