# OrcaSlicer profiles & slicing

Every quote is backed by a real headless OrcaSlicer run — no estimation. This
document covers the pinned version, the committed profiles, and how the worker
invokes the CLI.

## Version

Pinned to **OrcaSlicer v2.4.1** (`ORCA_VERSION` in `docker/worker.Dockerfile`).
The AppImage is extracted at image-build time (`--appimage-extract`; FUSE is
unavailable in containers) into `/opt/orca`, and run via `xvfb-run` because the
CLI still initialises wxWidgets/GL on some paths.

The persistent cache version is independently pinned in
`packages/shared/src/settings-key.ts`. Any Orca/profile change that can affect
toolpaths must bump `SLICE_PIPELINE_VERSION`; otherwise old price statistics
would be reused under the new slicer.

## The committed, flattened profiles

`apps/worker/profiles/` holds nine standalone JSON profiles:

| File | Source (Bambu A1) |
| --- | --- |
| `machine.bbl-a1-04.json` | Bambu Lab A1 0.4 nozzle |
| `process.0.12.json` / `.0.16.json` / `.0.20.json` | 0.12 Fine / 0.16 Optimal / 0.20 Standard |
| `filament.pla.json` | Numakers PLA+ (density 1.26) |
| `filament.pla-aesthetic.json` | Numakers PLA Silk (density 1.32) |
| `filament.pla-cf.json` | Numakers PLA-CF (density 1.22) |
| `filament.petg.json` | Numakers PETG HS (density 1.28) |
| `filament.petg-premium.json` | Numakers PETG-CF (density 1.25) |

Each material tier maps to one filament profile (`filamentProfile` in
`apps/worker/src/config.ts`).

**Grams — and therefore price — scale with `filament_density ×
filament_flow_ratio`**, not density alone. Measured on the 20 mm calibration
cube at 0.20 mm / 15% (2026-09-12), and reproduced exactly by that product:

| Profile | Density | Flow ratio | Grams |
| --- | --- | --- | --- |
| Bambu PLA Basic (previous `filament.pla.json`) | 1.26 | 0.980 | 3.67 |
| Numakers PLA+ (`filament.pla.json`) | 1.26 | 1.009 | 3.78 |
| Numakers PLA Silk (`filament.pla-aesthetic.json`) | 1.32 | 0.950 | 3.73 |
| Numakers PLA-CF (`filament.pla-cf.json`) | 1.22 | 0.950 | 3.45 |
| Numakers PETG HS (`filament.petg.json`) | 1.28 | 0.980 | 3.73 |
| Numakers PETG-CF (`filament.petg-premium.json`) | 1.25 | 0.960 | 3.57 |

Two tiers span several filament lines and slice them all with one preset, so
some lines in them are quoted slightly light:

- **Aesthetic PLA** uses the Silk preset for matte, metallic, starlight, glow,
  stone and wood too. Numakers' own Matte preset (density 1.32, flow 1.009)
  weighs ~6% more than Silk, so matte prints are quoted ~6% under their true
  filament use. There is no A1 preset for metallic/starlight/glow/stone, nor for
  wood on the A1.
- **PETG Premium** uses the PETG-CF preset for translucent PETG too, ~4% lighter
  than the PETG HS preset that plain translucent would slice with.

Splitting a line into its own tier (and profile) removes its error.

### Filament profiles: Numakers presets over a Bambu base

The filament profiles are the supplier's own presets from
<https://wiki.numakers.com/printing-tips/printer-profiles>, committed verbatim in
`scripts/profile-sources/numakers/`. They are exported flattened but not
uniformly (PETG-CF carries 73 keys where the rest carry ~108), and any key the CLI
does not receive falls back to Orca's built-in default. So
`scripts/overlay-numakers-profiles.py` lays each preset over the flattened Bambu
base for its family (`scripts/profile-sources/bambu-pla-basic.json` /
`generic-petg.json`): every key the base has is present, and every value
Numakers set wins. Re-run it after refreshing a vendor preset.

**Why flattened?** The stock profiles use `inherits:` chains. The OrcaSlicer CLI
does **not** resolve inheritance when given a profile directly — an un-flattened
profile yields `filament_density = 0` and empty weights. So each profile is
flattened (its full inheritance chain merged) once and committed.

### Re-flattening (Orca upgrade or profile change)

`scripts/flatten-orca-profiles.py` walks the `inherits` chain from the AppImage's
`resources/profiles/BBL/` and writes flattened JSONs, validating that
`filament_density > 0`. Filament presets land in `scripts/profile-sources/` as
overlay bases, never in `apps/worker/profiles/`, so re-flattening cannot clobber
the Numakers profiles. Re-run it against the new AppImage, then re-run
`overlay-numakers-profiles.py`, then the smoke check below before committing.

## How the worker slices

Per job (`apps/worker/src/orca.ts`):

1. Load the flattened process profile for the chosen layer height and **merge the
   customer's overrides into it** (the CLI can't take a partial override file):
   - infill → `sparse_infill_density = "<n>%"`
   - supports Off → `enable_support = "0"`; Auto → `"1"`; Always → `"1"` +
     `support_threshold_angle = "80"`
   Write the complete profile to `job-process.json`.
2. Invoke (essential flags):
   ```
   XDG_RUNTIME_DIR=/tmp/xdg xvfb-run -a /opt/orca/AppRun \
     --datadir <tmp> \
     --load-settings "machine.bbl-a1-04.json;job-process.json" \
     --load-filaments "filament.<material>.json" \
     --orient 1 --arrange 1 --slice 0 \
     --export-3mf out.3mf --outputdir <workdir> <model>
   ```
   Gotchas baked in: `--export-3mf` takes a **bare** filename + `--outputdir`;
   `XDG_RUNTIME_DIR` must exist (0700) or 3MF export fails.
3. Parse `Metadata/slice_info.config` from the exported 3MF:
   `prediction` (seconds), `weight`/`used_g` (grams), `used_m` (metres),
   `support_used` (bool).

Colour and quantity **never** touch slicing — colour is a record field, quantity
is a price multiplier.

## Thumbnails

The CLI (`--slice 0`) does **not** emit a plate thumbnail, so the worker
rasterises its own from the parsed mesh — a small dependency-free software
renderer (`packages/geometry/src/thumbnail.ts` + `png.ts`), no GL, no native
modules.
Thumbnails are written beside the model file under `uploads/thumbs/`.

## Smoke / upgrade gate

After any Orca or profile change, slice the bundled calibration cube
(`apps/worker/test-fixtures/calibration-cube.stl`) for every material × three
layer heights and confirm the reported grams land in a sane band. A 20 mm cube at
PLA/0.20/15% is ~5 g. If weights come back empty or zero, the inheritance
flattening is stale — re-run the flatten script.
Only deploy after updating the pinned AppImage SHA-256 and cache pipeline
version as well.

The CI HTTP funnel deliberately uses fixed synthetic measurements to test the
upload, BullMQ, checkout, and PDF integration without downloading Orca. It does
not exercise profiles or toolpaths and never replaces this real calibration
cube smoke/upgrade gate.
