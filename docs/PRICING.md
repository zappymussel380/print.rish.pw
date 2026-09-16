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

What the customer owes adds any prepaid shipping and, when the shop charges it, GST
(on printing + setup + shipping), and is then rounded half-up to a whole rupee
(`withTax` in `packages/shared/src/tax-settings.ts`):

```
exact      = total + shipping + GST
grandTotal = round(exact / 100) × 100
roundOff   = grandTotal − exact          (−50…+49 paise, its own "Round off" line)
```

Lines, setup fee, shipping and GST keep their paise; only the grand total is whole.
The quote page, checkout, the confirmation page, the PDF and the Telegram notice all
show the same figures, and `Quotation.roundOffPaise` freezes it (0 on quotations
issued before round off, whose totals may carry paise).

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

## The rates

The code defaults live in [`packages/shared/src/catalog.ts`](../packages/shared/src/catalog.ts)
(`CATALOG`) and [`costs.ts`](../packages/shared/src/costs.ts) (`INTERNAL_COST`).
Every one of them can be changed at runtime in **admin → Rates**, stored as the
`pricing` app setting and merged over the defaults by `normalizePricing`
([`pricing-settings.ts`](../packages/shared/src/pricing-settings.ts)). A shop
that has never saved rates runs on the defaults below.

| Item | Default |
| --- | --- |
| Setup fee | ₹150 / order |
| PLA sell | ₹2.00 / g (cost ₹600/kg, density 1.26) |
| Aesthetic PLA sell | ₹3.00 / g (cost ₹750/kg, density 1.32) — matte, silk, dual/tri-colour silk, metallic, stone, starlight, glow, wood |
| PLA-CF sell | ₹3.50 / g (cost ₹1,499/kg, density 1.22) |
| PETG sell | ₹2.50 / g (cost ₹800/kg, density 1.28) |
| PETG Premium sell | ₹3.50 / g (cost ₹1,149/kg, density 1.25) — translucent/glitter and carbon-fibre PETG |
| ABS sell | ₹2.50 / g (cost ₹650/kg, density 1.04) — placeholder rates, confirm before enabling |
| ASA sell | ₹3.00 / g (cost ₹900/kg, density 1.04) — placeholder rates, confirm before enabling |
| Electricity | ₹10 / kWh × 0.09 kWh per print-hour |
| Maintenance | ₹0.20 / g |
| Lead time | 8 print-hours/day + 2 buffer days |
| Bed | 256 × 256 × 256 mm (Bambu Lab A1) |

Colour never affects price; the material tier does. The three premium tiers
and ABS/ASA ship **disabled** (`DEFAULT_ENABLED_MATERIALS` in `colours.ts`) — the operator
switches each on, with its colours, from the admin catalog editor as the
filament is stocked. ABS and ASA have no supplier palette: their colours are
added in the same editor by name and hex code (any other tier can take such
custom colours too, alongside its Numakers palette). Each tier slices with its own Numakers profile, so grams
(and therefore price) follow that filament's density × flow ratio — see
[ORCA-PROFILES.md](ORCA-PROFILES.md) for the measured figures and the two tiers
that approximate some of their lines.

## Changing prices

Edit them in **admin → Rates**. Values are entered in rupees; each is
range-checked, and a save with any out-of-range value is refused and names the
field, so a typo is never silently priced. The live rates reach the quote page
server-rendered (`app/quote/layout.tsx`) and through `/api/catalog`, and the
checkout re-prices authoritatively with them on the server.

Existing quotations are unaffected — each stores its full catalog + breakdown in
`pricingSnapshot` at submission time, so a price change never rewrites history.
Admin profit, by contrast, is always recomputed with the current internal costs.

Unit tests in `packages/shared/src/pricing.test.ts` and
`pricing-settings.test.ts` assert rounding, quantity multiplication, every
material tier, the breakdown summing to the total, and that the defaults equal
the code rates — run `pnpm --filter @print/shared test` after any change.
