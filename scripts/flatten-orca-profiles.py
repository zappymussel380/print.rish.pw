#!/usr/bin/env python3
"""Flatten OrcaSlicer vendor profiles into standalone JSONs.

OrcaSlicer's CLI loads profile files passed via --load-settings/--load-filaments
verbatim: it does NOT resolve their `inherits` chains (observed on v2.4.1 —
filament_density arrives as "0" and slice_info weight is empty). This script
walks the inheritance chain inside the extracted AppImage's resources and emits
fully-merged profiles for the Bambu Lab A1 / 0.4 mm nozzle setup we ship.

Run inside the worker image (see docs/ORCA-PROFILES.md):

  docker run --rm -v "$PWD/apps/worker/profiles:/out" print-worker \
    python3 /out/../scripts/... # or copy the script in; see docs

Usage: flatten-orca-profiles.py <resources/profiles/BBL dir> <output dir>
"""
import json
import sys
from pathlib import Path

VENDOR_DIRS = ["machine", "process", "filament"]

# (source profile name, output filename) — the six presets print.rish.pw uses.
TARGETS = {
    "machine": [("Bambu Lab A1 0.4 nozzle", "machine.bbl-a1-04.json")],
    "process": [
        ("0.12mm Fine @BBL A1", "process.0.12.json"),
        ("0.16mm Optimal @BBL A1", "process.0.16.json"),
        ("0.20mm Standard @BBL A1", "process.0.20.json"),
    ],
    "filament": [
        ("Bambu PLA Basic @BBL A1", "filament.pla.json"),
        ("Generic PETG @BBL A1", "filament.petg.json"),
    ],
}


def build_index(vendor_root: Path) -> dict[str, Path]:
    """Map every profile `name` to its file across the vendor tree."""
    index: dict[str, Path] = {}
    for sub in VENDOR_DIRS:
        for f in (vendor_root / sub).glob("*.json"):
            try:
                name = json.loads(f.read_text())["name"]
            except (json.JSONDecodeError, KeyError):
                continue
            index[name] = f
    return index


def resolve(name: str, index: dict[str, Path], seen: tuple[str, ...] = ()) -> dict:
    if name in seen:
        raise RuntimeError(f"inheritance cycle: {' -> '.join(seen + (name,))}")
    if name not in index:
        raise RuntimeError(f"profile not found: {name!r} (needed by {seen[-1] if seen else '?'})")
    data = json.loads(index[name].read_text())
    parent_name = data.pop("inherits", None)
    if not parent_name:
        return data
    merged = resolve(parent_name, index, seen + (name,))
    merged.update(data)  # child keys win
    return merged


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    vendor_root, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    index = build_index(vendor_root)

    for kind, targets in TARGETS.items():
        for source_name, out_name in targets:
            profile = resolve(source_name, index)
            # Sanity: flattened filament profiles must carry a real density.
            if kind == "filament":
                density = float(profile.get("filament_density", ["0"])[0])
                if density <= 0:
                    raise RuntimeError(f"{source_name}: flattened but density still 0")
            (out_dir / out_name).write_text(json.dumps(profile, indent=2) + "\n")
            print(f"{out_name}  <-  {source_name}  ({len(profile)} keys)")


if __name__ == "__main__":
    main()
