#!/usr/bin/env python3
"""Build the shipped filament profiles from Numakers' own OrcaSlicer presets.

Numakers publishes per-filament presets for the Bambu Lab A1 at
https://wiki.numakers.com/printing-tips/printer-profiles. They are exported
"flattened" (`inherits: ""`), but not uniformly: the PETG-CF preset carries 73
keys where the stock ones carry ~108, and a key the CLI does not receive falls
back to Orca's built-in default rather than anything A1-appropriate.

So each vendor preset is laid over the flattened Bambu preset for its family
(`scripts/profile-sources/*.json`, written by flatten-orca-profiles.py): every
key the known-good base has is present, and every value Numakers set wins.

Usage: python3 scripts/overlay-numakers-profiles.py
Then bump SLICE_PIPELINE_VERSION and run the smoke gate in docs/ORCA-PROFILES.md.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "scripts" / "profile-sources"
OUT = ROOT / "apps" / "worker" / "profiles"

# (output filename, family base, Numakers preset) — one per material tier. A
# tier without a supplier preset (None) ships its base, cleaned up the same way.
TARGETS = [
    ("filament.pla.json", "bambu-pla-basic.json", "pla-plus.json"),
    ("filament.pla-aesthetic.json", "bambu-pla-basic.json", "pla-silk.json"),
    ("filament.pla-cf.json", "bambu-pla-basic.json", "pla-cf.json"),
    ("filament.petg.json", "generic-petg.json", "petg-hs.json"),
    ("filament.petg-premium.json", "generic-petg.json", "petg-cf.json"),
    ("filament.abs.json", "generic-abs.json", None),
    ("filament.asa.json", "generic-asa.json", None),
]

# Export-side bookkeeping that must not reach the CLI: an empty `inherits` is
# noise, and `setting_id` is Bambu's id for the *base* preset, not this one.
# `filament_notes` is a per-filament VECTOR option that these exports write as a
# bare "" — Orca 2.4.1 parses that as an empty vector and aborts before slicing
# ("ConfigOptionVector::set_at(): Assigning from an empty vector", exit 134).
DROP = {"inherits", "setting_id", "filament_notes"}


def overlay(base: dict, vendor: dict) -> dict:
    merged = {k: vendor.get(k, v) for k, v in base.items()}
    merged.update((k, v) for k, v in vendor.items() if k not in merged)
    for k in DROP:
        merged.pop(k, None)
    # Mark it a loadable preset exactly like the stock files the worker has
    # always shipped — Numakers exports carry `from: "User"` and no `type`.
    merged["type"] = "filament"
    merged["from"] = "system"
    merged["instantiation"] = "true"
    return merged


def main() -> None:
    for out_name, base_name, vendor_name in TARGETS:
        base = json.loads((SOURCES / base_name).read_text())
        vendor = json.loads((SOURCES / "numakers" / vendor_name).read_text()) if vendor_name else {}
        profile = overlay(base, vendor)
        density = float(profile.get("filament_density", ["0"])[0])
        if density <= 0:
            raise RuntimeError(f"{vendor_name or base_name}: no usable filament_density")
        (OUT / out_name).write_text(json.dumps(profile, indent=2) + "\n")
        print(f"{out_name:30} <- {vendor_name or '(base only)':14} on {base_name:22} "
              f"({len(profile)} keys, density {density})")


if __name__ == "__main__":
    main()
