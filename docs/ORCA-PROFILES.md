# OrcaSlicer profiles & slicing

Every quote is backed by a real headless OrcaSlicer run — no estimation. This
document covers the pinned version, the committed profiles, and how the worker
invokes the CLI.

## Version

Pinned to **OrcaSlicer v2.4.1** (`ORCA_VERSION` in `docker/worker.Dockerfile`).
The AppImage is extracted at image-build time (`--appimage-extract`; FUSE is
unavailable in containers) into `/opt/orca`, and run via `xvfb-run` because the
CLI still initialises wxWidgets/GL on some paths.

## The committed, flattened profiles

`apps/worker/profiles/` holds six standalone JSON profiles:

| File | Source (Bambu A1) |
| --- | --- |
| `machine.bbl-a1-04.json` | Bambu Lab A1 0.4 nozzle |
| `process.0.12.json` / `.0.16.json` / `.0.20.json` | 0.12 Fine / 0.16 Optimal / 0.20 Standard |
| `filament.pla.json` | Bambu PLA Basic (density 1.26) |
| `filament.petg.json` | Generic PETG (density 1.27) |

**Why flattened?** The stock profiles use `inherits:` chains. The OrcaSlicer CLI
does **not** resolve inheritance when given a profile directly — an un-flattened
profile yields `filament_density = 0` and empty weights. So each profile is
flattened (its full inheritance chain merged) once and committed.

### Re-flattening (Orca upgrade or profile change)

`scripts/flatten-orca-profiles.py` walks the `inherits` chain from the AppImage's
`resources/profiles/BBL/` and writes flattened JSONs, validating that
`filament_density > 0`. Re-run it against the new AppImage, then run the smoke
check below before committing.

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
renderer (`apps/worker/src/thumbnail.ts` + `png.ts`), no GL, no native modules.
Thumbnails are written beside the model file under `uploads/thumbs/`.

## Smoke / upgrade gate

After any Orca or profile change, slice the bundled calibration cube
(`apps/worker/test-fixtures/calibration-cube.stl`) for both materials × three
layer heights and confirm the reported grams land in a sane band. A 20 mm cube at
PLA/0.20/15% is ~5 g. If weights come back empty or zero, the inheritance
flattening is stale — re-run the flatten script.
