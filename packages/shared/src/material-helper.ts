// Zod-free: the quote page's "Help me choose" imports these. Validation of
// what admin sends lives in material-helper-schema.ts.
import { MATERIAL_IDS, type MaterialId } from "./quote-types";

/**
 * "Help me choose": a customer ticks what matters for their part and the
 * material that rates best on those needs is picked for them. The shop rates
 * every material 0–3 on each need (admin → Filament → Material helper), can
 * switch any built-in need off, and can add up to four needs of its own.
 */
export const BUILT_IN_NEEDS = ["looks", "strength", "heat", "outdoor"] as const;
export const OWN_NEEDS = ["own1", "own2", "own3", "own4"] as const;
export const NEED_IDS = [...BUILT_IN_NEEDS, ...OWN_NEEDS] as const;
export type BuiltInNeed = (typeof BUILT_IN_NEEDS)[number];
export type OwnNeed = (typeof OWN_NEEDS)[number];
export type NeedId = (typeof NEED_IDS)[number];

/** 0 = not suited, 1 = OK, 2 = good, 3 = best. */
export type NeedScore = 0 | 1 | 2 | 3;
export const NEED_SCORE_LABELS: Record<NeedScore, string> = { 0: "—", 1: "OK", 2: "Good", 3: "Best" };

export const OWN_NEED_LIMITS = { label: 24, description: 120 } as const;

/** The built-in needs' copy: a chip label, the hint under it, and how the
 *  picker's reason line names it ("good for heat resistance"). */
export const BUILT_IN_NEED_COPY: Record<BuiltInNeed, { label: string; description: string; phrase: string }> = {
  looks: { label: "Looks", description: "The best finish and fine detail, for display pieces and gifts", phrase: "looks" },
  strength: { label: "Strength", description: "Tough parts that take knocks and loads", phrase: "strength" },
  heat: { label: "Heat resistance", description: "Survives hot cars, lamps and electronics", phrase: "heat resistance" },
  outdoor: { label: "Outdoor / sun", description: "Keeps its colour and strength in sun and rain", phrase: "outdoor use" },
};

export interface OwnNeedSettings {
  label: string;
  description: string;
  enabled: boolean;
}

export type NeedScores = Partial<Record<NeedId, NeedScore>>;

export interface MaterialHelperSettings {
  /** Show "Help me choose" on the quote page. */
  enabled: boolean;
  /** Each built-in need, on or off. */
  builtIn: Record<BuiltInNeed, boolean>;
  /** The shop's own needs, by slot. */
  own: Partial<Record<OwnNeed, OwnNeedSettings>>;
  /** How each material rates on each need; missing = 0. */
  scores: Partial<Record<MaterialId, NeedScores>>;
}

/** Ratings for the stock tiers, from the /materials comparison (MATERIAL_GUIDE).
 *  PLA and Aesthetic PLA tie on looks, so the cheaper PLA is the pick. */
export const DEFAULT_NEED_SCORES: Partial<Record<MaterialId, NeedScores>> = {
  PLA: { looks: 3, strength: 1, heat: 0, outdoor: 0 },
  PLA_AESTHETIC: { looks: 3, strength: 1, heat: 0, outdoor: 0 },
  PLA_CF: { looks: 2, strength: 2, heat: 0, outdoor: 1 },
  PETG: { looks: 2, strength: 2, heat: 2, outdoor: 2 },
  PETG_PREMIUM: { looks: 2, strength: 2, heat: 2, outdoor: 2 },
  ABS: { looks: 1, strength: 3, heat: 3, outdoor: 1 },
  ASA: { looks: 1, strength: 3, heat: 3, outdoor: 3 },
};

export function defaultMaterialHelper(): MaterialHelperSettings {
  return {
    enabled: true,
    builtIn: { looks: true, strength: true, heat: true, outdoor: true },
    own: {},
    scores: Object.fromEntries(Object.entries(DEFAULT_NEED_SCORES).map(([id, scores]) => [id, { ...scores }])),
  };
}

function isScore(value: unknown): value is NeedScore {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/** Collapse whitespace and trim; null when blank or longer than `max`. */
function cleanText(value: unknown, max: number, allowBlank: boolean): string | null {
  if (typeof value !== "string") return allowBlank ? "" : null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > max) return null;
  if (!text && !allowBlank) return null;
  return text;
}

export function cleanOwnNeed(raw: unknown): OwnNeedSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label = cleanText(r.label, OWN_NEED_LIMITS.label, false);
  const description = cleanText(r.description, OWN_NEED_LIMITS.description, true);
  if (label === null || description === null) return null;
  return { label, description, enabled: r.enabled !== false };
}

/** A stored blob, hardened: unknown needs and materials are dropped, scores
 *  outside 0–3 ignored, and a stock tier with no saved rating keeps its default
 *  — so a damaged row degrades to the defaults rather than a broken picker. */
export function normalizeMaterialHelper(raw: unknown): MaterialHelperSettings {
  const out = defaultMaterialHelper();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;

  const builtIn = r.builtIn && typeof r.builtIn === "object" ? (r.builtIn as Record<string, unknown>) : {};
  for (const id of BUILT_IN_NEEDS) if (typeof builtIn[id] === "boolean") out.builtIn[id] = builtIn[id] as boolean;

  const own = r.own && typeof r.own === "object" ? (r.own as Record<string, unknown>) : {};
  for (const id of OWN_NEEDS) {
    const need = cleanOwnNeed(own[id]);
    if (need) out.own[id] = need;
  }

  const scores = r.scores && typeof r.scores === "object" ? (r.scores as Record<string, unknown>) : {};
  for (const material of MATERIAL_IDS) {
    const saved = scores[material];
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) continue;
    const merged: NeedScores = { ...out.scores[material] };
    for (const need of NEED_IDS) {
      const value = (saved as Record<string, unknown>)[need];
      if (isScore(value)) merged[need] = value;
    }
    out.scores[material] = merged;
  }
  return out;
}

export interface PublicNeed {
  id: NeedId;
  label: string;
  description: string;
  /** How the reason line names it: "good for heat resistance". */
  phrase: string;
}

/** What the quote page gets: the needs a customer can tick, and the ratings
 *  of the materials it offers. */
export interface PublicMaterialHelper {
  needs: PublicNeed[];
  scores: Partial<Record<MaterialId, NeedScores>>;
}

/** Lower-case a label's first letter for use mid-sentence, unless it reads as
 *  an acronym ("UV safe" stays, "Food safe" → "food safe"). */
function asPhrase(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
}

/** The helper as customers get it; null when it's off or has no needs on. */
export function toPublicMaterialHelper(
  settings: MaterialHelperSettings,
  offered: readonly MaterialId[],
): PublicMaterialHelper | null {
  if (!settings.enabled) return null;
  const needs: PublicNeed[] = [
    ...BUILT_IN_NEEDS.filter((id) => settings.builtIn[id]).map((id) => ({ id, ...BUILT_IN_NEED_COPY[id] })),
    ...OWN_NEEDS.flatMap((id) => {
      const need = settings.own[id];
      return need?.enabled ? [{ id, label: need.label, description: need.description, phrase: asPhrase(need.label) }] : [];
    }),
  ];
  if (needs.length === 0 || offered.length === 0) return null;
  const scores: Partial<Record<MaterialId, NeedScores>> = {};
  for (const material of offered) {
    const all = settings.scores[material] ?? {};
    const kept: NeedScores = {};
    for (const need of needs) if (all[need.id]) kept[need.id] = all[need.id];
    scores[material] = kept;
  }
  return { needs, scores };
}

export interface MaterialPick {
  id: MaterialId;
  /** The pick's rating on each need the customer ticked. */
  ratings: { need: NeedId; score: NeedScore }[];
}

/**
 * The material that rates best on the ticked needs: the highest total score,
 * then the lower per-gram rate, then the catalog's order. Null when nothing is
 * ticked, or no offered material rates above zero on any of it.
 */
export function pickMaterial(
  selected: readonly NeedId[],
  candidates: readonly { id: MaterialId; sellPerGramPaise: number }[],
  scores: Partial<Record<MaterialId, NeedScores>>,
): MaterialPick | null {
  if (selected.length === 0) return null;
  let best: { id: MaterialId; total: number; rate: number } | null = null;
  for (const candidate of candidates) {
    const rated = scores[candidate.id] ?? {};
    const total = selected.reduce((sum, need) => sum + (rated[need] ?? 0), 0);
    if (total === 0) continue;
    if (!best || total > best.total || (total === best.total && candidate.sellPerGramPaise < best.rate)) {
      best = { id: candidate.id, total, rate: candidate.sellPerGramPaise };
    }
  }
  if (!best) return null;
  const rated = scores[best.id] ?? {};
  return { id: best.id, ratings: selected.map((need) => ({ need, score: rated[need] ?? 0 })) };
}

const SCORE_WORDS: Record<NeedScore, string> = { 3: "great for", 2: "good for", 1: "OK for", 0: "not made for" };

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The reason line under the picker: "PETG: good for strength and heat
 *  resistance", best ratings first, and honest about a need it can't meet
 *  ("PLA: great for looks, not made for heat resistance"). */
export function describePick(pick: MaterialPick, materialName: string, needs: readonly PublicNeed[]): string {
  const phrase = (id: NeedId) => needs.find((n) => n.id === id)?.phrase ?? id;
  // Within a rating, in the order the needs are offered, not the order ticked.
  const order = (id: NeedId) => needs.findIndex((n) => n.id === id);
  const ratings = [...pick.ratings].sort((a, b) => order(a.need) - order(b.need));
  const groups = ([3, 2, 1, 0] as const).flatMap((score) => {
    const named = ratings.filter((r) => r.score === score).map((r) => phrase(r.need));
    return named.length > 0 ? [`${SCORE_WORDS[score]} ${joinAnd(named)}`] : [];
  });
  return `${materialName}: ${groups.join(", ")}`;
}
