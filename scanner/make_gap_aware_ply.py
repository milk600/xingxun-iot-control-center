#!/usr/bin/env python3
"""Group real, filled-gap, and room-framework points in an OpenMVS-style PLY."""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from uniformize_openmvs_ply import OUTPUT_VERTEX_DTYPE, load_openmvs_vertices


def parse_values(value: str, count: int, label: str) -> np.ndarray:
    result = np.fromstring(value, sep=",", dtype=np.float64)
    if result.size != count or not np.isfinite(result).all():
        raise argparse.ArgumentTypeError(f"{label} must contain {count} finite values")
    return result


def parse_axes(value: str) -> np.ndarray:
    axes = parse_values(value, 9, "axes").reshape(3, 3)
    axes[0] /= np.linalg.norm(axes[0])
    axes[1] -= axes[0] * np.dot(axes[1], axes[0])
    axes[1] /= np.linalg.norm(axes[1])
    axes[2] = np.cross(axes[0], axes[1])
    axes[2] /= np.linalg.norm(axes[2])
    return axes


def parse_bounds(value: str) -> np.ndarray:
    bounds = parse_values(value, 6, "bounds").reshape(3, 2)
    if np.any(bounds[:, 1] <= bounds[:, 0]):
        raise argparse.ArgumentTypeError("every upper bound must exceed its lower bound")
    return bounds


def nearest_distances(
    tree: cKDTree,
    xyz: np.ndarray,
    workers: int,
    batch_size: int,
) -> np.ndarray:
    distances = np.empty(len(xyz), dtype=np.float32)
    for start in range(0, len(xyz), batch_size):
        end = min(start + batch_size, len(xyz))
        distances[start:end], _indices = tree.query(
            xyz[start:end], k=1, workers=workers
        )
        print(f"Gap analysis {end:,}/{len(xyz):,}", flush=True)
    return distances


def make_header(
    vertex_count: int,
    real_count: int,
    interior_gap_count: int,
    framework_count: int,
    axes: np.ndarray,
    bounds: np.ndarray,
) -> bytes:
    gap_start = real_count
    gap_count = interior_gap_count + framework_count
    framework_start = real_count + interior_gap_count
    comments = [
        "comment Gap-aware open-top presentation cloud",
        "comment vertex_group_0 real_capture",
        "comment vertex_group_1 interior_gap_fill",
        "comment vertex_group_2 room_framework",
        f"comment real_vertex_start 0",
        f"comment real_vertex_count {real_count}",
        f"comment gap_vertex_start {gap_start}",
        f"comment gap_vertex_count {gap_count}",
        f"comment framework_vertex_start {framework_start}",
        f"comment framework_vertex_count {framework_count}",
    ]
    for index, axis in enumerate(axes):
        comments.append(
            f"comment room_axis_{index} " + " ".join(f"{value:.9g}" for value in axis)
        )
    for index, axis_bounds in enumerate(bounds):
        comments.append(
            f"comment room_bounds_{index} {axis_bounds[0]:.9g} {axis_bounds[1]:.9g}"
        )
    return (
        "ply\n"
        "format binary_little_endian 1.0\n"
        + "\n".join(comments)
        + "\n"
        + f"element vertex {vertex_count}\n"
        + "property float32 x\n"
        + "property float32 y\n"
        + "property float32 z\n"
        + "property uint8 red\n"
        + "property uint8 green\n"
        + "property uint8 blue\n"
        + "property float32 nx\n"
        + "property float32 ny\n"
        + "property float32 nz\n"
        + "property list uint8 uint32 view_indices\n"
        + "property list uint8 float32 view_weights\n"
        + "end_header\n"
    ).encode("ascii")


def make_subset_header(
    vertex_count: int,
    group_name: str,
    axes: np.ndarray,
    bounds: np.ndarray,
) -> bytes:
    comments = [
        "comment Open-top presentation cloud group",
        f"comment vertex_group {group_name}",
    ]
    for index, axis in enumerate(axes):
        comments.append(
            f"comment room_axis_{index} " + " ".join(f"{value:.9g}" for value in axis)
        )
    for index, axis_bounds in enumerate(bounds):
        comments.append(
            f"comment room_bounds_{index} {axis_bounds[0]:.9g} {axis_bounds[1]:.9g}"
        )
    return (
        "ply\n"
        "format binary_little_endian 1.0\n"
        + "\n".join(comments)
        + "\n"
        + f"element vertex {vertex_count}\n"
        + "property float32 x\n"
        + "property float32 y\n"
        + "property float32 z\n"
        + "property uint8 red\n"
        + "property uint8 green\n"
        + "property uint8 blue\n"
        + "property float32 nx\n"
        + "property float32 ny\n"
        + "property float32 nz\n"
        + "property list uint8 uint32 view_indices\n"
        + "property list uint8 float32 view_weights\n"
        + "end_header\n"
    ).encode("ascii")


def write_records(path: Path, records: np.ndarray, header: bytes, force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(f"output already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        with temporary.open("wb") as stream:
            stream.write(header)
            records.tofile(stream)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a grouped gap-aware colored PLY")
    parser.add_argument("source", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--interior-gap-output", type=Path)
    parser.add_argument("--framework-output", type=Path)
    parser.add_argument("--axes", type=parse_axes, required=True)
    parser.add_argument("--bounds", type=parse_bounds, required=True)
    parser.add_argument("--gap-threshold", type=float, default=0.055)
    parser.add_argument("--framework-tolerance", type=float, default=0.035)
    parser.add_argument("--workers", type=int, default=14)
    parser.add_argument("--batch-size", type=int, default=120_000)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    started = time.perf_counter()
    source = args.source.resolve()
    reference = args.reference.resolve()
    output = args.output.resolve()
    if not source.is_file() or not reference.is_file():
        raise FileNotFoundError("source or reference PLY does not exist")
    if output in (source, reference):
        raise ValueError("output must not overwrite an input")
    if output.exists() and not args.force:
        raise FileExistsError(f"output already exists: {output}")

    xyz, colors, normals = load_openmvs_vertices(source)
    reference_xyz, _reference_colors, _reference_normals = load_openmvs_vertices(reference)
    tree = cKDTree(reference_xyz, leafsize=32, compact_nodes=True, balanced_tree=True)
    distances = nearest_distances(tree, xyz, args.workers, args.batch_size)
    gap = distances > args.gap_threshold

    local = xyz.astype(np.float64) @ args.axes.T
    tolerance = args.framework_tolerance
    # The roof was intentionally removed.  The framework group contains the
    # floor and four surrounding walls, plus gap points snapped onto them.
    framework_plane = np.abs(local[:, 0] - args.bounds[0, 1]) <= tolerance
    for dimension in (1, 2):
        framework_plane |= np.abs(local[:, dimension] - args.bounds[dimension, 0]) <= tolerance
        framework_plane |= np.abs(local[:, dimension] - args.bounds[dimension, 1]) <= tolerance
    framework = gap & framework_plane
    interior_gap = gap & ~framework
    real = ~gap

    real_indices = np.flatnonzero(real)
    interior_indices = np.flatnonzero(interior_gap)
    framework_indices = np.flatnonzero(framework)
    order = np.concatenate((real_indices, interior_indices, framework_indices))
    if len(order) != len(xyz):
        raise RuntimeError("point grouping did not cover every vertex")

    records = np.zeros(len(order), dtype=OUTPUT_VERTEX_DTYPE)
    ordered_xyz = xyz[order]
    ordered_colors = colors[order]
    ordered_normals = normals[order]
    records["x"], records["y"], records["z"] = ordered_xyz.T
    records["red"], records["green"], records["blue"] = ordered_colors.T
    records["nx"], records["ny"], records["nz"] = ordered_normals.T

    write_records(
        output,
        records,
        make_header(
            len(records),
            len(real_indices),
            len(interior_indices),
            len(framework_indices),
            args.axes,
            args.bounds,
        ),
        args.force,
    )

    interior_start = len(real_indices)
    framework_start = interior_start + len(interior_indices)
    if args.interior_gap_output:
        interior_output = args.interior_gap_output.resolve()
        write_records(
            interior_output,
            records[interior_start:framework_start],
            make_subset_header(
                len(interior_indices), "interior_gap_fill", args.axes, args.bounds
            ),
            args.force,
        )
        print(f"Interior gap group output: {interior_output}")
    if args.framework_output:
        framework_output = args.framework_output.resolve()
        write_records(
            framework_output,
            records[framework_start:],
            make_subset_header(
                len(framework_indices), "room_framework", args.axes, args.bounds
            ),
            args.force,
        )
        print(f"Framework group output: {framework_output}")

    print(f"Real capture points: {len(real_indices):,}")
    print(f"Interior gap-fill points: {len(interior_indices):,}")
    print(f"Room framework points: {len(framework_indices):,}")
    print(f"Output: {output}")
    print(f"Size: {output.stat().st_size / 1024 / 1024:.2f} MiB")
    print(f"Elapsed: {time.perf_counter() - started:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
