#!/usr/bin/env python3
"""Generate a 20 mm binary-STL calibration cube used as the slicing smoke-test fixture.

Usage: python3 scripts/make-test-cube.py [output-path] [size-mm]
"""
import struct
import sys

out = sys.argv[1] if len(sys.argv) > 1 else "apps/worker/test-fixtures/calibration-cube.stl"
size = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0

# 8 cube corners
v = [(x, y, z) for z in (0.0, size) for y in (0.0, size) for x in (0.0, size)]
# 12 triangles (two per face), outward-facing winding
faces = [
    (0, 2, 1), (1, 2, 3),  # bottom (z=0), normal -Z
    (4, 5, 6), (5, 7, 6),  # top (z=size), normal +Z
    (0, 1, 4), (1, 5, 4),  # front (y=0), normal -Y
    (2, 6, 3), (3, 6, 7),  # back (y=size), normal +Y
    (0, 4, 2), (2, 4, 6),  # left (x=0), normal -X
    (1, 3, 5), (3, 7, 5),  # right (x=size), normal +X
]

def normal(a, b, c):
    ux, uy, uz = (b[i] - a[i] for i in range(3))
    vx, vy, vz = (c[i] - a[i] for i in range(3))
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    length = (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5 or 1.0
    return tuple(x / length for x in n)

with open(out, "wb") as f:
    f.write(b"calibration cube (generated)".ljust(80, b"\0"))
    f.write(struct.pack("<I", len(faces)))
    for a, b, c in faces:
        f.write(struct.pack("<3f", *normal(v[a], v[b], v[c])))
        for idx in (a, b, c):
            f.write(struct.pack("<3f", *v[idx]))
        f.write(struct.pack("<H", 0))
print(f"wrote {out} ({size} mm cube)")
