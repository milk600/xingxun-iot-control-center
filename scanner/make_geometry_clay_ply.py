#!/usr/bin/env python3
"""Create a gray-white clay render PLY that emphasizes point-cloud geometry."""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from uniformize_openmvs_ply import OUTPUT_VERTEX_DTYPE, load_openmvs_vertices


def parse_axes(value: str) -> np.ndarray:
    raw = np.fromstring(value, sep=",", dtype=np.float64)
    if raw.size != 9:
        raise argparse.ArgumentTypeError("axes must contain nine comma-separated values")
    axes = raw.reshape(3, 3)
    axes[0] /= np.linalg.norm(axes[0])
    axes[1] -= axes[0] * np.dot(axes[1], axes[0])
    axes[1] /= np.linalg.norm(axes[1])
    axes[2] = np.cross(axes[0], axes[1])
    axes[2] /= np.linalg.norm(axes[2])
    return axes


def normalized_rows(values: np.ndarray) -> np.ndarray:
    lengths = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.maximum(lengths, 1e-8)


def geometry_gray_colors(
    xyz: np.ndarray,
    normals: np.ndarray,
    axes: np.ndarray,
    workers: int,
    batch_size: int,
    neighbors: int,
    edge_strength: float,
) -> tuple[np.ndarray, np.ndarray]:
    normals = normalized_rows(normals.astype(np.float32, copy=False))

    # Ceiling-side key light plus a lateral fill light.  Using two-sided
    # illumination keeps imported or reconstructed flipped normals usable.
    key_light = -axes[0] - 0.38 * axes[1] + 0.28 * axes[2]
    key_light /= np.linalg.norm(key_light)
    fill_light = -0.45 * axes[0] + 0.65 * axes[1] + 0.55 * axes[2]
    fill_light /= np.linalg.norm(fill_light)
    key = np.abs(normals @ key_light)
    fill = np.abs(normals @ fill_light)
    diffuse = 0.72 * key + 0.28 * fill

    tree = cKDTree(xyz, leafsize=32, compact_nodes=True, balanced_tree=True)
    curvature = np.empty(len(xyz), dtype=np.float32)
    k = max(4, min(neighbors, len(xyz)))
    for start in range(0, len(xyz), batch_size):
        end = min(start + batch_size, len(xyz))
        _distances, indices = tree.query(
            xyz[start:end], k=k, workers=workers
        )
        center = normals[start:end, None, :]
        agreement = np.abs(np.sum(center * normals[indices], axis=2)).mean(axis=1)
        # A small dead zone suppresses normal noise on broad planar regions.
        curvature[start:end] = np.clip((0.94 - agreement) / 0.34, 0.0, 1.0)
        print(f"Geometry shading {end:,}/{len(xyz):,}", flush=True)

    # Light clay surfaces with darker creases/corners.  The limited range keeps
    # the model readable against both white and dark viewers without pure black.
    intensity = 154.0 + 86.0 * diffuse - edge_strength * curvature
    intensity = np.clip(np.rint(intensity), 82, 242).astype(np.uint8)
    colors = np.repeat(intensity[:, None], 3, axis=1)
    return colors, curvature


def make_header(vertex_count: int, axes: np.ndarray) -> bytes:
    comments = [
        "comment Open-top gray-white geometry clay cloud",
        "comment Baked two-sided normal lighting and corner darkening",
    ]
    for index, axis in enumerate(axes):
        comments.append(
            f"comment room_axis_{index} " + " ".join(f"{value:.9g}" for value in axis)
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a gray-white geometry PLY")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--axes", type=parse_axes, required=True)
    parser.add_argument("--neighbors", type=int, default=12)
    parser.add_argument("--edge-strength", type=float, default=48.0)
    parser.add_argument("--workers", type=int, default=14)
    parser.add_argument("--batch-size", type=int, default=100_000)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    started = time.perf_counter()
    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if source == output:
        raise ValueError("output must not overwrite the input")
    if output.exists() and not args.force:
        raise FileExistsError(f"output already exists: {output}")

    xyz, _source_colors, normals = load_openmvs_vertices(source)
    colors, curvature = geometry_gray_colors(
        xyz,
        normals,
        args.axes,
        args.workers,
        args.batch_size,
        args.neighbors,
        args.edge_strength,
    )

    records = np.zeros(len(xyz), dtype=OUTPUT_VERTEX_DTYPE)
    records["x"], records["y"], records["z"] = xyz.T
    records["red"], records["green"], records["blue"] = colors.T
    records["nx"], records["ny"], records["nz"] = normals.T

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        with temporary.open("wb") as stream:
            stream.write(make_header(len(records), args.axes))
            records.tofile(stream)
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise

    print(f"Points: {len(records):,}")
    print(f"Gray range: {int(colors.min())}..{int(colors.max())}")
    print(
        "Corner emphasis p50/p90/p99: "
        + "/".join(f"{value:.3f}" for value in np.percentile(curvature, [50, 90, 99]))
    )
    print(f"Output: {output}")
    print(f"Size: {output.stat().st_size / 1024 / 1024:.2f} MiB")
    print(f"Elapsed: {time.perf_counter() - started:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
