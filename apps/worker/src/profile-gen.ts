/**
 * Printer profiles for self-hosted shops: turn any single-extruder, 0.4 mm
 * printer that OrcaSlicer ships into the standalone profile set the worker
 * slices with — one machine profile, a process profile per layer height and a
 * filament profile per material tier — plus `printer.json`, the printer's
 * description for the rest of the app (build volume, plate per material …).
 *
 *   node dist/profile-gen.js list [profilesRoot]
 *   node dist/profile-gen.js generate "<machine preset name>" <outDir> [--multi-material] [--name "<shown name>"] [profilesRoot]
 *
 * The Orca CLI does not resolve `inherits`, so every profile is flattened. A
 * preset's parent may live in another vendor's folder (OrcaFilamentLibrary
 * generics are everyone's fallback), so the index spans every vendor.
 * The Bambu Lab A1 keeps the hand-tuned Numakers set committed in
 * apps/worker/profiles instead (scripts/overlay-numakers-profiles.py).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LAYER_HEIGHTS_UM,
  MATERIAL_IDS,
  bedOf,
  cleanProfile,
  firstValue as first,
  plateFor,
  type MaterialId,
  type OrcaProfile as Profile,
  type PrinterProfileSpec,
  type ProfileKind as Kind,
} from "@print/shared";

export { bedOf, plateFor };

interface IndexEntry {
  vendor: string;
  path: string;
}

export const DEFAULT_PROFILES_ROOT = "/opt/orca/resources/profiles";
export const A1_MACHINE = "Bambu Lab A1 0.4 nozzle";

// ── Index + flattening ────────────────────────────────────────────────────────
export class ProfileIndex {
  private readonly entries = new Map<string, IndexEntry[]>();

  constructor(readonly root: string) {
    for (const vendor of readdirSync(root)) {
      const vendorDir = join(root, vendor);
      if (!statSync(vendorDir).isDirectory()) continue;
      for (const kind of ["machine", "process", "filament"] as const) {
        const dir = join(vendorDir, kind);
        if (existsSync(dir)) this.walk(dir, vendor, kind);
      }
    }
  }

  private walk(dir: string, vendor: string, kind: Kind) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        this.walk(path, vendor, kind);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      let presetName: unknown;
      try {
        presetName = (JSON.parse(readFileSync(path, "utf8")) as Profile).name;
      } catch {
        continue;
      }
      if (typeof presetName !== "string") continue;
      const key = `${kind}:${presetName}`;
      const list = this.entries.get(key) ?? [];
      list.push({ vendor, path });
      this.entries.set(key, list);
    }
  }

  raw(kind: Kind, name: string, preferVendor?: string): { profile: Profile; vendor: string } | null {
    const list = this.entries.get(`${kind}:${name}`);
    if (!list?.length) return null;
    const hit = list.find((e) => e.vendor === preferVendor) ?? list[0]!;
    return { profile: JSON.parse(readFileSync(hit.path, "utf8")) as Profile, vendor: hit.vendor };
  }

  /** The preset with its whole `inherits` chain merged (child keys win). */
  flatten(kind: Kind, name: string, preferVendor?: string, seen: string[] = []): Profile & { __vendor: string } {
    if (seen.includes(name)) throw new Error(`inheritance cycle: ${[...seen, name].join(" -> ")}`);
    const found = this.raw(kind, name, preferVendor);
    if (!found) throw new Error(`${kind} preset not found: ${name}`);
    const { profile, vendor } = found;
    const parent = typeof profile.inherits === "string" && profile.inherits ? profile.inherits : null;
    delete profile.inherits;
    const merged = parent ? this.flatten(kind, parent, vendor, [...seen, name]) : { __vendor: vendor };
    return Object.assign(merged, profile, { __vendor: vendor });
  }

  /** A preset that isn't in the index — one the owner uploaded — with its
   *  `inherits` chain resolved: first against presets uploaded with it (a
   *  bundle), then against the presets this OrcaSlicer ships. */
  flattenPreset(kind: Kind, preset: Profile, peers: readonly Profile[] = [], seen: string[] = []): Profile {
    const name = String(preset.name ?? "");
    if (seen.includes(name)) throw new Error(`inheritance cycle: ${[...seen, name].join(" -> ")}`);
    const own: Profile = { ...preset };
    const parent = typeof own.inherits === "string" && own.inherits ? own.inherits : null;
    delete own.inherits;
    if (!parent) return own;
    const peer = peers.find((p) => p !== preset && p.name === parent);
    if (peer) return Object.assign(this.flattenPreset(kind, peer, peers, [...seen, name]), own);
    if (!this.raw(kind, parent)) {
      throw new Error(
        `"${name}" is based on "${parent}", which isn't one of the presets this OrcaSlicer ships. ` +
          "Export it together with the preset it's based on (as a bundle), or pick a system preset as its parent.",
      );
    }
    return Object.assign(this.flatten(kind, parent), own);
  }

  /** Every instantiable preset of a kind, flattened. */
  *instantiable(kind: Kind): Generator<Profile & { __vendor: string }> {
    for (const [key, list] of this.entries) {
      if (!key.startsWith(`${kind}:`)) continue;
      const name = key.slice(kind.length + 1);
      const raw = JSON.parse(readFileSync(list[0]!.path, "utf8")) as Profile;
      if (raw.instantiation !== "true") continue;
      try {
        yield this.flatten(kind, name, list[0]!.vendor);
      } catch {
        // A broken vendor chain only removes that one preset from the choice.
      }
    }
  }
}

// ── Compatibility ─────────────────────────────────────────────────────────────
const notes = (m: Profile): string => (Array.isArray(m.printer_notes) ? m.printer_notes.join("\n") : String(m.printer_notes ?? ""));

/** Orca's `compatible_printers_condition`, for the forms its bundled presets use:
 *  `printer_notes=~/…/`, `printer_notes!~/…/`, `nozzle_diameter[0]==x` and
 *  `single_extruder_multi_material`, joined by `and`. Unknown forms fail closed. */
export function conditionMatches(condition: string, machine: Profile): boolean {
  if (!condition.trim()) return true;
  for (const raw of condition.split(/\s+and\s+/)) {
    const part = raw.trim().replace(/^\(|\)$/g, "");
    let m = /^printer_notes\s*(=~|!~)\s*\/(.*)\/$/.exec(part);
    if (m) {
      const hit = new RegExp(m[2]!).test(notes(machine));
      if ((m[1] === "=~") !== hit) return false;
      continue;
    }
    m = /^nozzle_diameter\[0\]\s*==\s*([0-9.]+)$/.exec(part);
    if (m) {
      if (Math.abs(Number(first(machine.nozzle_diameter)) - Number(m[1])) > 1e-6) return false;
      continue;
    }
    if (part === "single_extruder_multi_material") {
      if (first(machine.single_extruder_multi_material) !== "1") return false;
      continue;
    }
    return false;
  }
  return true;
}

export function isCompatible(preset: Profile, machineName: string, machine: Profile): boolean {
  const list = Array.isArray(preset.compatible_printers) ? (preset.compatible_printers as string[]) : [];
  if (list.length > 0) return list.includes(machineName);
  return conditionMatches(String(preset.compatible_printers_condition ?? ""), machine);
}

// ── Printer list ──────────────────────────────────────────────────────────────
export interface PrinterChoice {
  vendor: string;
  /** Exact machine preset name — what `generate` takes. */
  machine: string;
  /** Human model name, e.g. "Prusa MK4". */
  model: string;
  bedMm: [number, number, number];
}

/** Single-extruder FFF printers with a 0.4 mm nozzle — the setups our three
 *  layer heights and seven material tiers are defined for. */
export function listPrinters(index: ProfileIndex): PrinterChoice[] {
  const out: PrinterChoice[] = [];
  for (const m of index.instantiable("machine")) {
    const nozzles = Array.isArray(m.nozzle_diameter) ? m.nozzle_diameter : [m.nozzle_diameter];
    if (nozzles.length !== 1 || Number(first(nozzles)) !== 0.4) continue;
    if (String(m.printer_technology ?? "FFF") !== "FFF") continue;
    const bed = bedOf(m);
    if (bed.some((d) => d <= 0)) continue;
    out.push({
      vendor: m.__vendor,
      machine: String(m.name),
      model: String(m.printer_model || m.name).trim(),
      bedMm: bed,
    });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model));
}

// ── Choosing presets ──────────────────────────────────────────────────────────
const PROCESS_PREFERENCE: Record<number, RegExp> = {
  120: /fine/i,
  160: /optimal/i,
  200: /standard/i,
};

const OTHER_PLACEHOLDER = { types: ["PETG", "PET"], name: /\bGeneric PETG\b/i, exclude: /cf|hf|gf/i };

/** What each tier slices as when the printer has no hand-tuned preset. */
export const TIER_FILAMENTS: Record<MaterialId, { types: string[]; name: RegExp; exclude?: RegExp }> = {
  PLA: { types: ["PLA"], name: /\bGeneric PLA\b/i, exclude: /silk|matte|high speed|cf|glow|wood|marble|metal|\+/i },
  PLA_AESTHETIC: { types: ["PLA"], name: /silk/i },
  PLA_CF: { types: ["PLA-CF"], name: /cf/i },
  PETG: { types: ["PETG", "PET"], name: /\bGeneric PETG\b/i, exclude: /cf|hf|gf/i },
  PETG_PREMIUM: { types: ["PETG-CF", "PETG", "PET"], name: /petg[- ]?cf/i },
  ABS: { types: ["ABS"], name: /\bGeneric ABS\b/i, exclude: /gf|cf/i },
  ASA: { types: ["ASA"], name: /\bGeneric ASA\b/i, exclude: /gf|cf|aero/i },
  // The shop's own materials: a placeholder so every set is complete. The owner
  // replaces it in admin, and a slot isn't offered until they have.
  OTHER_1: OTHER_PLACEHOLDER,
  OTHER_2: OTHER_PLACEHOLDER,
  OTHER_3: OTHER_PLACEHOLDER,
  OTHER_4: OTHER_PLACEHOLDER,
};

function pickProcess(
  presets: Profile[],
  machineName: string,
  machine: Profile,
  layerUm: number,
): Profile | null {
  const mm = layerUm / 1000;
  const fits = presets.filter(
    (p) => Math.abs(Number(first(p.layer_height)) - mm) < 1e-6 && isCompatible(p, machineName, machine),
  );
  const preferred = fits.filter((p) => PROCESS_PREFERENCE[layerUm]!.test(String(p.name)));
  return (preferred.length ? preferred : fits).sort((a, b) => String(a.name).length - String(b.name).length)[0] ?? null;
}

function pickFilament(
  filaments: (Profile & { __vendor: string })[],
  tier: MaterialId,
  machineName: string,
  machine: Profile & { __vendor: string },
): Profile | null {
  const rule = TIER_FILAMENTS[tier];
  const candidates = filaments.filter(
    (f) =>
      rule.types.includes(first(f.filament_type)) &&
      rule.name.test(String(f.name)) &&
      !(rule.exclude?.test(String(f.name)) ?? false) &&
      isCompatible(f, machineName, machine),
  );
  const rank = (f: Profile & { __vendor: string }) =>
    (f.__vendor === machine.__vendor ? 0 : f.__vendor === "OrcaFilamentLibrary" ? 1 : 2) * 10 +
    (/^generic/i.test(String(f.name)) ? 0 : 1);
  return candidates.sort((a, b) => rank(a) - rank(b) || String(a.name).length - String(b.name).length)[0] ?? null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export interface GeneratedSet {
  spec: PrinterProfileSpec;
  files: Record<string, Profile>;
}

/** Build the whole profile set for one printer, without touching the disk. */
export function generateProfiles(
  index: ProfileIndex,
  machineName: string,
  multiMaterial: boolean,
  displayName?: string,
): GeneratedSet {
  const machine = index.flatten("machine", machineName);
  const choice = listPrinters(index).find((p) => p.machine === machineName);
  if (!choice) throw new Error(`${machineName} is not a single-extruder 0.4 mm printer this shop can quote for`);

  const processes = [...index.instantiable("process")];
  const filaments = [...index.instantiable("filament")];
  const files: Record<string, Profile> = {};
  files["machine.json"] = cleanProfile(machine, "machine", machineName, machineName);

  const compatibleProcesses = processes.filter((p) => isCompatible(p, machineName, machine));
  for (const um of LAYER_HEIGHTS_UM) {
    let preset = pickProcess(processes, machineName, machine, um);
    if (!preset) {
      // About half of Orca's printers lack a 0.16 mm preset, a few a 0.12 mm one:
      // derive it from the printer's own preset closest in layer height, which
      // only differs in layer height for our purposes.
      const target = um / 1000;
      const nearest = [...compatibleProcesses].sort(
        (a, b) =>
          Math.abs(Number(first(a.layer_height)) - target) - Math.abs(Number(first(b.layer_height)) - target) ||
          String(a.name).length - String(b.name).length,
      )[0];
      if (nearest) {
        preset = { ...nearest, layer_height: target.toFixed(2), name: `${target.toFixed(2)}mm (derived from ${String(nearest.name)})` };
      }
    }
    if (!preset) throw new Error(`${machineName}: no process preset compatible with this printer`);
    const label = String(preset.name);
    files[`process.${(um / 1000).toFixed(2)}.json`] = cleanProfile(preset, "process", label, machineName);
  }

  const plates = {} as Record<MaterialId, string>;
  const sources = {} as Record<MaterialId, string>;
  for (const tier of MATERIAL_IDS) {
    const preset = pickFilament(filaments, tier, machineName, machine);
    if (!preset) throw new Error(`${machineName}: no filament preset for ${tier}`);
    const density = Number(first(preset.filament_density));
    if (!(density > 0)) throw new Error(`${machineName}: ${String(preset.name)} has no density`);
    files[`filament.${slug(tier)}.json`] = cleanProfile(preset, "filament", `${String(preset.name)} (${tier})`, machineName);
    plates[tier] = plateFor(preset);
    sources[tier] = String(preset.name);
  }

  const spec: PrinterProfileSpec = {
    id: slug(machineName),
    machine: machineName,
    name: displayName || choice.model,
    vendor: choice.vendor,
    nozzleMm: 0.4,
    bedMm: choice.bedMm,
    multiMaterial,
    plates,
    filamentPresets: sources,
    generated: true,
  };
  return { spec, files };
}

/** Write a set to `outDir` (worker-readable: 0755 dir, 0644 files). */
export function writeProfileSet(set: GeneratedSet, outDir: string) {
  mkdirSync(outDir, { recursive: true, mode: 0o755 });
  for (const [name, profile] of Object.entries(set.files)) {
    writeFileSync(join(outDir, name), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o644 });
  }
  writeFileSync(join(outDir, "printer.json"), `${JSON.stringify(set.spec, null, 2)}\n`, { mode: 0o644 });
}

/** The A1 keeps the committed, hand-tuned Numakers set; only printer.json is new. */
export function writeA1Set(committedDir: string, outDir: string, multiMaterial: boolean, spec: PrinterProfileSpec) {
  mkdirSync(outDir, { recursive: true, mode: 0o755 });
  for (const name of readdirSync(committedDir)) {
    if (name.endsWith(".json") && name !== "printer.json") copyFileSync(join(committedDir, name), join(outDir, name));
  }
  writeFileSync(join(outDir, "printer.json"), `${JSON.stringify({ ...spec, multiMaterial }, null, 2)}\n`, { mode: 0o644 });
}

// ── CLI ───────────────────────────────────────────────────────────────────────
export async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const multi = rest.includes("--multi-material");
  const nameAt = rest.indexOf("--name");
  const displayName = nameAt >= 0 ? rest[nameAt + 1]?.trim().slice(0, 120) : undefined;
  const args = rest.filter((a, i) => a !== "--multi-material" && (nameAt < 0 || (i !== nameAt && i !== nameAt + 1)));
  if (command === "list") {
    const index = new ProfileIndex(args[0] ?? DEFAULT_PROFILES_ROOT);
    for (const p of listPrinters(index)) {
      process.stdout.write(`${p.vendor}\t${p.model}\t${p.machine}\t${p.bedMm.join("x")}\n`);
    }
    return;
  }
  if (command === "generate" && args[0] && args[1]) {
    const [machineName, outDir, root] = args as [string, string, string?];
    if (machineName === A1_MACHINE) {
      const { DEFAULT_PRINTER_SPEC } = await import("@print/shared");
      // Never config.profilesDir: the installer runs this with PROFILES_DIR
      // pointing at the shop's own set — the very dir being replaced.
      const { COMMITTED_PROFILES_DIR } = await import("./config.js");
      writeA1Set(COMMITTED_PROFILES_DIR, outDir, multi, {
        ...DEFAULT_PRINTER_SPEC,
        ...(displayName ? { name: displayName } : {}),
      });
      process.stdout.write(`Bambu Lab A1: using the committed Numakers profiles\n`);
      return;
    }
    const set = generateProfiles(new ProfileIndex(root ?? DEFAULT_PROFILES_ROOT), machineName, multi, displayName);
    writeProfileSet(set, outDir);
    process.stdout.write(
      `${set.spec.name}: ${Object.keys(set.files).length} profiles, bed ${set.spec.bedMm.join("×")} mm\n` +
        Object.entries(set.spec.filamentPresets ?? {})
          .map(([tier, preset]) => `  ${tier.padEnd(13)} ${preset} (${set.spec.plates[tier as MaterialId]})`)
          .join("\n") +
        "\n",
    );
    return;
  }
  process.stderr.write('usage: profile-gen.js list [root] | generate "<machine>" <outDir> [--multi-material] [--name "<shown name>"] [root]\n');
  process.exitCode = 64;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
