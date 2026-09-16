/** Money helpers. All amounts are integer paise (₹1 = 100 paise). */

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}

const inrWhole = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** A total: "₹1,457" when it is a whole rupee (every total since round off),
 *  else with its paise, as older quotations were issued. */
export function formatTotal(paise: number): string {
  return paise % 100 === 0 ? inrWhole.format(paise / 100) : formatPaise(paise);
}

/** A round-off line, always signed: "+₹0.25", "−₹0.29". */
export function formatRoundOff(paise: number): string {
  return `${paise < 0 ? "−" : "+"}${formatPaise(Math.abs(paise))}`;
}

/** "2h 5m" style duration for print times. */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function formatGrams(grams: number): string {
  return grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${grams.toFixed(1)} g`;
}

export function formatFilamentLength(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`;
}
