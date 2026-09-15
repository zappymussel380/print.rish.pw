// Zod-free: checkout (client) and the estimator (server) both import these,
// so the page shows exactly the shipping the server will charge.

const PACKAGING_GRAMS = 200;

/** Part weight + packaging, billed by Shiprocket's 0.5 kg slabs. */
export function billedWeightKg(weightGrams: number): number {
  return Math.max(0.5, Math.ceil(((weightGrams + PACKAGING_GRAMS) / 1000) * 2) / 2);
}

/** The rate-affecting parcel dimensions Shiprocket bills on: the 0.5 kg-slab
 *  billed weight and the declared value in whole rupees (clamped). Isolated so
 *  the cache key, the upstream call, and the signed estimate token all derive
 *  them identically from the same authoritative weight/value. */
export function shippingBinding(weightGrams: number, declaredValuePaise: number) {
  return {
    weightKg: billedWeightKg(weightGrams),
    declaredValue: Math.min(1_000_000, Math.max(1, Math.round(declaredValuePaise / 100))),
  };
}

/** Which parcel a quote ships as. Two quotes with the same key are priced the
 *  same by the courier, and checkout's token check accepts an estimate for
 *  either — so the page keys a saved estimate by this, never by the exact
 *  quote, or a small edit shows no shipping while checkout still charges it. */
export function shippingParcelKey(weightGrams: number, declaredValuePaise: number): string {
  const { weightKg, declaredValue } = shippingBinding(weightGrams, declaredValuePaise);
  return `${weightKg}:${declaredValue}`;
}
