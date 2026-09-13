import { z } from "zod";
import { materialFamily, type MaterialFamily } from "./catalog";
import type { MaterialId } from "./quote-types";
import { listJoin } from "./site-profile";

/**
 * The FAQ, written from the shop's own settings — materials and colours in
 * stock, the printer, lead time, shipping, retention — so every shop running
 * this software answers truthfully about itself. Shop-specific policies (custom
 * colour minimums, design services, payment methods …) are the shop's own
 * custom entries (admin → FAQ), not baked in here.
 */
export interface FaqEntry {
  /** Stable id: lets the admin hide a generated entry. Custom entries use `custom-…`. */
  id: string;
  q: string;
  a: string;
  more?: { href: string; label: string };
}

export interface FaqContext {
  /** Materials currently on sale. */
  materials: { id: MaterialId; name: string }[];
  /** Distinct colours in stock across those materials (black in PLA and PETG counts once). */
  colourCount: number;
  printer: { name: string; bedMm: readonly [number, number, number]; multiMaterial: boolean };
  city: string;
  leadTime: { printHoursPerDay: number; bufferDays: number };
  /** Live courier quotes are configured (Shiprocket). */
  courierQuotes: boolean;
  retention: { uploadHours: number; fileDays: number };
  /** How customers reach the shop, e.g. "WhatsApp" or "the contact page". */
  contactChannel: string;
}

const HEAT: Record<MaterialFamily, string> = {
  PLA: "PLA handles static indoor loads well but softens around 55–60 °C",
  PETG: "PETG takes impacts, heat up to ~80 °C and outdoor exposure",
  ABS: "ABS is tough and holds its shape to ~95–100 °C",
  ASA: "ASA adds long-term sun and weather resistance to ABS's toughness",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildFaq(ctx: FaqContext): FaqEntry[] {
  const [x, y, z] = ctx.printer.bedMm;
  const names = ctx.materials.map((m) => m.name);
  const families = [...new Set(ctx.materials.map((m) => materialFamily(m.id)))];
  const pickup = ctx.city ? ` Pickup in ${ctx.city} is available once printing finishes.` : "";
  const ask = `ask us on ${ctx.contactChannel}`;

  const entries: (FaqEntry | null)[] = [
    {
      id: "formats",
      q: "Which file formats can I upload?",
      a: "STL, 3MF, OBJ and AMF — plus STEP/STP, which is converted for you automatically on upload. STL is the safest export from almost any CAD tool. If your software offers 3MF, prefer it — it preserves units and orientation more reliably.",
    },
    {
      id: "accuracy",
      q: "How accurate is the instant quote?",
      a: `Very — it isn't an estimate from geometry: your file is actually sliced by OrcaSlicer with the same ${ctx.printer.name} profile the printer runs. The filament weight and print time in your quote come from the generated toolpath itself.`,
    },
    {
      id: "weight-estimate",
      q: "Can I gauge weight and cost before I have a file?",
      a: "Once you upload there's no need to guess — the quote is exact, sliced from your actual model. Before that, model libraries like MakerWorld, Printables, Thingiverse and the Yeggi aggregator often list a typical weight for popular prints, which is a fair ballpark.",
      more: { href: "/find-models", label: "Where to find models" },
    },
    {
      id: "per-gram",
      q: "Why is pricing per gram?",
      a: "Because material is what a print actually consumes, so per-gram billing stays fair and transparent — you pay for your model, not a flat guess. Small items are genuinely cheap: a keychain is only a few grams of filament plus the one-time setup fee. The live per-gram rate for each material is on the Pricing page.",
      more: { href: "/pricing", label: "See the rates" },
    },
    names.length > 0
      ? {
          id: "materials",
          q: "Which materials can you print?",
          a: `Right now: ${listJoin(names)}. Each is priced per gram at its own rate, and the Materials page compares them side by side — strength, flexibility, heat and outdoor resistance. Not sure which fits your part? Describe what it's for in your quote notes.`,
          more: { href: "/materials", label: "Compare materials" },
        }
      : null,
    {
      id: "max-size",
      q: "What's the maximum printable size?",
      a: `${x} × ${y} × ${z} mm — the full build volume of the ${ctx.printer.name}. Larger parts can often be split into pieces and joined; ${ask} and we'll advise.`,
    },
    ctx.colourCount > 0
      ? {
          id: "colours",
          q: "Which colours are available?",
          a: `Every colour in stock is in the colour picker on the quote page — ${plural(ctx.colourCount, "colour")} across ${listJoin(names)} at the moment. Looking for one that isn't listed? ${ask[0]!.toUpperCase()}${ask.slice(1)} — depending on the job, it may be possible to order it in.`,
        }
      : null,
    {
      id: "multicolour",
      q: "Can you do multicolour prints?",
      a: ctx.printer.multiMaterial
        ? "Yes — the printer can switch between several filaments during a print, so parts can combine colours layer by layer or region by region. Multicolour prints take longer and use some extra filament for each colour change; mention what you have in mind in your quote notes."
        : "The printer uses one filament at a time, so multicolour is done by hand: swapping filament at set points during the print, or printing parts separately and assembling them. It works best when colours split cleanly by height or by component. Tell us what you have in mind and we'll say what's practical.",
    },
    {
      id: "turnaround",
      q: "How long until I get my prints?",
      a: `Your quote shows an estimated completion date: the total print time, spread over about ${plural(ctx.leadTime.printHoursPerDay, "printing hour")} a day, plus ${plural(ctx.leadTime.bufferDays, "day")} for preparation and quality checks.${pickup}`,
    },
    {
      id: "shipping",
      q: "Do you ship?",
      a: ctx.courierQuotes
        ? `Yes — anywhere in India by courier. Enter your pincode on the quote page for a live estimate; shipping is confirmed with you after your quotation.${pickup}`
        : `Delivery is arranged with you after your quotation — ${ask} about options and cost.${pickup}`,
    },
    {
      id: "layer-lines",
      q: "Will I see layer lines?",
      a: "Yes — every FDM print has them; they're the nature of the process. At 0.12 mm layer height they're subtle and mostly disappear at arm's length. Choose 0.12 mm for display pieces and 0.20 mm for functional parts where speed and price matter more.",
    },
    {
      id: "durability",
      q: "How durable are printed parts?",
      a: `Very usable in daily life.${families.length > 0 ? ` ${families.map((f) => HEAT[f]).join("; ")}.` : ""} Strength also depends on print orientation and infill — if a part is load-bearing, say so in the notes so it can be oriented and tuned for strength.`,
    },
    {
      id: "supports",
      q: "What about supports — do they leave marks?",
      a: "Overhanging geometry needs support material, which is included in your quoted weight. After removal there can be slight surface marks on supported faces. 'Auto' lets the slicer decide where supports are needed; choose 'Off' only if you know your model prints safely without them.",
    },
    {
      id: "infill",
      q: "What's infill, and should I change it?",
      a: "Infill is the internal lattice inside a print — solid plastic on the outside, an open honeycomb within. More infill means a stronger, heavier and slightly pricier part; less means lighter and cheaper. The default of 15% is plenty for most décor and display pieces; raise it for parts that carry load.",
    },
    {
      id: "payment",
      q: "How do I pay?",
      a: "There's no online payment here — submitting a quotation costs nothing and commits you to nothing. The details are confirmed with you first, and payment is arranged once you approve the final quote.",
    },
    {
      id: "retention",
      q: "How long do you keep my files and details?",
      a: `Uploads that never become a quotation request are deleted automatically within ${plural(ctx.retention.uploadHours, "hour")}. Model files attached to an order are removed ${plural(ctx.retention.fileDays, "day")} after completion. The quotation record, PDF, contact and delivery details are kept for at most 90 days after completion or cancellation, then the next daily cleanup removes them. They are used only to process your order — never analysed, sold or used for marketing. Processing may share them with the shop's messaging and email accounts and the shipping provider, whose copies follow their own retention schedules.`,
    },
  ];
  return entries.filter((e): e is FaqEntry => e !== null);
}

// ── Shop-managed extras (admin → FAQ) ──────────────────────────────────────────

export const FAQ_LIMITS = { entries: 30, question: 160, answer: 2000 } as const;

export interface FaqSettings {
  /** The shop's own Q&As, shown after the generated ones, in this order. */
  custom: FaqEntry[];
  /** Ids of generated entries the shop has chosen not to show. */
  hidden: string[];
}

const customEntrySchema = z.object({
  id: z.string().regex(/^custom-[a-z0-9-]{1,40}$/),
  q: z.string().trim().min(1).max(FAQ_LIMITS.question),
  a: z.string().trim().min(1).max(FAQ_LIMITS.answer),
});

export const faqSettingsSchema = z.object({
  custom: z.array(customEntrySchema).max(FAQ_LIMITS.entries),
  hidden: z.array(z.string().max(40)).max(FAQ_LIMITS.entries),
});

export function normalizeFaqSettings(raw: unknown): FaqSettings {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const custom: FaqEntry[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(obj.custom) ? obj.custom : []) {
    const parsed = customEntrySchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    custom.push(parsed.data);
    if (custom.length >= FAQ_LIMITS.entries) break;
  }
  const hidden = (Array.isArray(obj.hidden) ? obj.hidden : [])
    .filter((id): id is string => typeof id === "string" && id.length <= 40)
    .slice(0, FAQ_LIMITS.entries);
  return { custom, hidden: [...new Set(hidden)] };
}

/** What the public page shows: generated entries the shop hasn't hidden, then its own. */
export function composeFaq(generated: FaqEntry[], settings: FaqSettings): FaqEntry[] {
  const hidden = new Set(settings.hidden);
  return [...generated.filter((e) => !hidden.has(e.id)), ...settings.custom];
}
