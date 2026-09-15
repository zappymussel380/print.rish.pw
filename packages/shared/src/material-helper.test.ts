import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import {
  defaultMaterialHelper,
  describePick,
  normalizeMaterialHelper,
  pickMaterial,
  toPublicMaterialHelper,
  type NeedId,
} from "./material-helper";
import { materialHelperInputSchema } from "./material-helper-schema";
import type { MaterialId } from "./quote-types";

const ALL_STOCK: MaterialId[] = ["PLA", "PLA_AESTHETIC", "PLA_CF", "PETG", "PETG_PREMIUM", "ABS", "ASA"];
const candidates = (ids: MaterialId[]) => ids.map((id) => ({ id, sellPerGramPaise: CATALOG.materials[id].sellPerGramPaise }));
const pick = (needs: NeedId[], ids: MaterialId[] = ALL_STOCK) =>
  pickMaterial(needs, candidates(ids), defaultMaterialHelper().scores)?.id ?? null;

describe("pickMaterial on the default ratings", () => {
  it("picks what the shop owner described", () => {
    // Good looking, not strong: PLA (ties Aesthetic PLA on looks, and is cheaper).
    expect(pick(["looks"])).toBe("PLA");
    // Strong, not necessarily heat resistant: ABS (ties ASA, cheaper).
    expect(pick(["strength"])).toBe("ABS");
    expect(pick(["outdoor"])).toBe("ASA");
    expect(pick(["strength", "heat"])).toBe("ABS");
    expect(pick(["strength", "outdoor"])).toBe("ASA");
  });

  it("only picks from what's on sale", () => {
    const noEngineering: MaterialId[] = ["PLA", "PETG"];
    expect(pick(["heat"], noEngineering)).toBe("PETG");
    expect(pick(["strength"], noEngineering)).toBe("PETG");
    expect(pick(["looks"], noEngineering)).toBe("PLA");
  });

  it("picks nothing when nothing is ticked, or nothing on sale rates for it", () => {
    expect(pick([])).toBeNull();
    expect(pick(["heat"], ["PLA", "PLA_AESTHETIC"])).toBeNull();
    expect(pick(["own1"])).toBeNull();
  });

  it("breaks a tie on the lower rate, then catalog order", () => {
    const scores = { PETG: { looks: 2 }, PLA: { looks: 2 } } as const;
    expect(pickMaterial(["looks"], [{ id: "PETG", sellPerGramPaise: 250 }, { id: "PLA", sellPerGramPaise: 200 }], scores)?.id).toBe("PLA");
    expect(pickMaterial(["looks"], [{ id: "PETG", sellPerGramPaise: 200 }, { id: "PLA", sellPerGramPaise: 200 }], scores)?.id).toBe("PETG");
  });
});

describe("describePick", () => {
  const needs = toPublicMaterialHelper(defaultMaterialHelper(), ALL_STOCK)!.needs;

  it("says why, best ratings first, and owns up to a need it can't meet", () => {
    const petg = pickMaterial(["strength", "heat"], candidates(["PLA", "PETG"]), defaultMaterialHelper().scores)!;
    expect(describePick(petg, "PETG", needs)).toBe("PETG: good for strength and heat resistance");
    const pla = pickMaterial(["looks", "heat"], candidates(["PLA"]), defaultMaterialHelper().scores)!;
    expect(describePick(pla, "PLA", needs)).toBe("PLA: great for looks, not made for heat resistance");
    // Ticked heat first, then looks: still read in the order they're offered.
    const both = pickMaterial(["heat", "looks"], candidates(["PLA", "PETG"]), defaultMaterialHelper().scores)!;
    expect(describePick(both, "PETG", needs)).toBe("PETG: good for looks and heat resistance");
    const asa = pickMaterial(["outdoor", "looks"], candidates(["ASA"]), defaultMaterialHelper().scores)!;
    expect(describePick(asa, "ASA", needs)).toBe("ASA: great for outdoor use, OK for looks");
  });
});

describe("toPublicMaterialHelper", () => {
  it("offers the needs switched on, the shop's own named ones after the built-in", () => {
    const settings = normalizeMaterialHelper({
      builtIn: { looks: true, strength: true, heat: false, outdoor: true },
      own: { own2: { label: "Food contact", description: "Safe for food", enabled: true }, own3: { label: "Hidden", description: "", enabled: false } },
      scores: { PETG: { own2: 3 } },
    });
    const helper = toPublicMaterialHelper(settings, ["PLA", "PETG"])!;
    expect(helper.needs.map((n) => n.id)).toEqual(["looks", "strength", "outdoor", "own2"]);
    expect(helper.needs.at(-1)).toEqual({ id: "own2", label: "Food contact", description: "Safe for food", phrase: "food contact" });
    // Only the materials on sale, and only the needs on offer.
    expect(Object.keys(helper.scores)).toEqual(["PLA", "PETG"]);
    expect(helper.scores.PETG).toEqual({ looks: 2, strength: 2, outdoor: 2, own2: 3 });
  });

  it("is off when the shop switches it off or leaves no need on", () => {
    expect(toPublicMaterialHelper({ ...defaultMaterialHelper(), enabled: false }, ALL_STOCK)).toBeNull();
    expect(
      toPublicMaterialHelper({ ...defaultMaterialHelper(), builtIn: { looks: false, strength: false, heat: false, outdoor: false } }, ALL_STOCK),
    ).toBeNull();
  });
});

describe("normalizeMaterialHelper", () => {
  it("falls back to the defaults for anything damaged", () => {
    expect(normalizeMaterialHelper(null)).toEqual(defaultMaterialHelper());
    expect(normalizeMaterialHelper("nope")).toEqual(defaultMaterialHelper());
    const damaged = normalizeMaterialHelper({
      enabled: "yes",
      own: { own1: { label: "  ", description: "x" }, own9: { label: "Extra" }, own4: { label: "x".repeat(25) } },
      scores: { PLA: { looks: 7, heat: 2, bogus: 3 }, NYLON: { looks: 3 } },
    });
    expect(damaged.enabled).toBe(true);
    expect(damaged.own).toEqual({});
    expect(damaged.scores.PLA).toEqual({ looks: 3, strength: 1, heat: 2, outdoor: 0 });
    expect(damaged.scores).not.toHaveProperty("NYLON");
  });

  it("keeps a stock tier's default ratings where nothing was saved for it", () => {
    const saved = normalizeMaterialHelper({ scores: { PLA: { looks: 1 } } });
    expect(saved.scores.PLA?.looks).toBe(1);
    expect(saved.scores.ASA).toEqual(defaultMaterialHelper().scores.ASA);
  });
});

describe("materialHelperInputSchema", () => {
  it("takes the whole helper, and refuses an unnamed need or a score outside 0–3", () => {
    const ok = { ...defaultMaterialHelper(), own: { own1: { label: "Flexible", description: "", enabled: true } } };
    expect(materialHelperInputSchema.safeParse(ok).success).toBe(true);
    expect(materialHelperInputSchema.safeParse({ ...ok, own: { own1: { label: " ", description: "", enabled: true } } }).success).toBe(false);
    expect(materialHelperInputSchema.safeParse({ ...ok, scores: { PLA: { looks: 4 } } }).success).toBe(false);
    expect(materialHelperInputSchema.safeParse({ ...ok, scores: { PLA: { strong: 2 } } }).success).toBe(false);
  });
});
