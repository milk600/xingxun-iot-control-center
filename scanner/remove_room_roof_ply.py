#!/usr/bin/env python3
"""Remove the roof and above-roof outliers from an OpenMVS-style colored PLY."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np

from uniformize_openmvs_ply import OUTPUT_VERTEX_DTYPE, load_openmvs_vertices


def parse_axis(value: str) -> np.ndarray:
    axis = np.fromstring(value, sep=",", dtype=np.float64)
    if axis.size != 3:
        raise argparse.ArgumentTypeError("axis must contain three comma-separated values")
    length = np.linalg.norm(axis)
    if not np.isfinite(length) or length <= 0:
        raise argparse.ArgumentTypeError("axis must be finite and non-zero")
    return axis / length


def make_header(vertex_count: int, axis: np.ndarray, roof_limit: float) -> bytes:
    axis_text = " ".join(f"{value:.9g}" for value in axis)
    return (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "comment Open-top presentation cloud; roof and above-roof outliers removed\n"
        f"comment vertical_axis {axis_text}\n"
        f"comment open_top_cutoff {roof_limit:.9g}\n"
        f"element vertex {vertex_count}\n"
        "property float32 x\n"
        "property float32 y\n"
        "property float32 z\n"
        "property uint8 red\n"
        "property uint8 green\n"
        "property uint8 blue\n"
        "property float32 nx\n"
        "property float32 ny\n"
        "property float32 nz\n"
        "property list uint8 uint32 view_indices\n"
        "property list uint8 float32 view_weights\n"
        "end_header\n"
    ).encode("ascii")


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove a room roof from a colored PLY")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--axis", type=parse_axis, required=True)
    parser.add_argument("--roof-bound", type=float, required=True)
    parser.add_argument(
        "--clearance",
        type=float,
        default=0.10,
        help="Remove points up to this distance below the roof boundary",
    )
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if output.exists() and not args.force:
        raise FileExistsError(f"output already exists: {output}")
    if source == output:
        raise ValueError("output must not overwrite the input")

    xyz, colors, normals = load_openmvs_vertices(source)
    cutoff = args.roof_bound + args.clearance
    height = xyz.astype(np.float64) @ args.axis
    keep = height > cutoff
    removed = int(np.count_nonzero(~keep))

    xyz = xyz[keep]
    colors = colors[keep]
    normals = normals[keep]
    records = np.zeros(len(xyz), dtype=OUTPUT_VERTEX_DTYPE)
    records["x"], records["y"], records["z"] = xyz.T
    records["red"], records["green"], records["blue"] = colors.T
    records["nx"], records["ny"], records["nz"] = normals.T

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        with temporary.open("wb") as stream:
            stream.write(make_header(len(records), args.axis, cutoff))
            records.tofile(stream)
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise

    print(f"Removed roof/above-roof points: {removed:,}")
    print(f"Remaining points: {len(records):,}")
    print(f"Open-top cutoff: {cutoff:.4f}")
    print(f"Output: {output}")
    print(f"Size: {output.stat().st_size / 1024 / 1024:.2f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
