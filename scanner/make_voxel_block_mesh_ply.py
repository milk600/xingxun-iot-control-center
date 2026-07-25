#!/usr/bin/env python3
"""Convert an open-top room point cloud to a Manhattan-aligned voxel block mesh."""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

from uniformize_openmvs_ply import load_openmvs_vertices


VERTEX_DTYPE = np.dtype(
    [
        ("x", "<f4"),
        ("y", "<f4"),
        ("z", "<f4"),
        ("nx", "<f4"),
        ("ny", "<f4"),
        ("nz", "<f4"),
        ("red", "u1"),
        ("green", "u1"),
        ("blue", "u1"),
    ],
    align=False,
)

FACE_DTYPE = np.dtype(
    [("count", "u1"), ("a", "<i4"), ("b", "<i4"), ("c", "<i4")],
    align=False,
)


FACE_DEFINITIONS = (
    # Neighbor delta, local outward normal, four counter-clockwise corners.
    ((-1, 0, 0), (-1, 0, 0), ((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0))),
    ((1, 0, 0), (1, 0, 0), ((1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1))),
    ((0, -1, 0), (0, -1, 0), ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1))),
    ((0, 1, 0), (0, 1, 0), ((0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0))),
    ((0, 0, -1), (0, 0, -1), ((0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0))),
    ((0, 0, 1), (0, 0, 1), ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1))),
)


def parse_values(value: str, count: int, label: str) -> np.ndarray:
    result = np.fromstring(value, sep=",", dtype=np.float64)
    if result.size != count or not np.isfinite(result).all():
        raise argparse.ArgumentTypeError(f"{label} must contain {count} finite values")
    return result


def parse_axes(value: str) -> np.ndarray:
    raw = parse_values(value, 9, "axes").reshape(3, 3)
    raw[0] /= np.linalg.norm(raw[0])
    raw[1] -= raw[0] * np.dot(raw[1], raw[0])
    raw[1] /= np.linalg.norm(raw[1])
    raw[2] = np.cross(raw[0], raw[1])
    raw[2] /= np.linalg.norm(raw[2])
    return raw


def parse_bounds(value: str) -> np.ndarray:
    bounds = parse_values(value, 6, "bounds").reshape(3, 2)
    if np.any(bounds[:, 1] <= bounds[:, 0]):
        raise argparse.ArgumentTypeError("every upper bound must exceed its lower bound")
    return bounds


def build_occupancy(
    local_xyz: np.ndarray,
    bounds: np.ndarray,
    voxel_size: float,
    minimum_points: int,
    minimum_component: int,
) -> tuple[np.ndarray, np.ndarray, int, int]:
    dimensions = np.ceil((bounds[:, 1] - bounds[:, 0]) / voxel_size).astype(np.int32)
    upper = bounds[:, 0] + dimensions * voxel_size
    inside = np.all((local_xyz >= bounds[:, 0]) & (local_xyz < upper), axis=1)
    cells = np.floor((local_xyz[inside] - bounds[:, 0]) / voxel_size).astype(np.int32)
    flat = np.ravel_multi_index(cells.T, tuple(dimensions))
    counts = np.bincount(flat, minlength=int(np.prod(dimensions))).reshape(tuple(dimensions))
    occupied = counts >= minimum_points

    labels, component_count = ndimage.label(
        occupied, structure=np.ones((3, 3, 3), dtype=bool)
    )
    component_sizes = np.bincount(labels.ravel())
    keep_component = component_sizes >= minimum_component
    keep_component[0] = False
    before = int(np.count_nonzero(occupied))
    occupied = keep_component[labels]
    removed = before - int(np.count_nonzero(occupied))
    return occupied, dimensions, int(np.count_nonzero(inside)), removed


def exposed_cells(occupied: np.ndarray, delta: np.ndarray) -> np.ndarray:
    cells = np.argwhere(occupied).astype(np.int32)
    neighbors = cells + delta
    in_grid = np.all((neighbors >= 0) & (neighbors < np.asarray(occupied.shape)), axis=1)
    covered = np.zeros(len(cells), dtype=bool)
    valid = neighbors[in_grid]
    covered[in_grid] = occupied[valid[:, 0], valid[:, 1], valid[:, 2]]
    return cells[~covered]


def make_mesh(
    occupied: np.ndarray,
    origin: np.ndarray,
    voxel_size: float,
    axes: np.ndarray,
    source_xyz: np.ndarray,
    source_colors: np.ndarray,
    color_mode: str,
    workers: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    vertices_parts: list[np.ndarray] = []
    normals_parts: list[np.ndarray] = []
    colors_parts: list[np.ndarray] = []
    faces_parts: list[np.ndarray] = []
    vertex_offset = 0

    key_light = -axes[0] - 0.35 * axes[1] + 0.25 * axes[2]
    key_light /= np.linalg.norm(key_light)
    fill_light = -0.35 * axes[0] + 0.70 * axes[1] + 0.45 * axes[2]
    fill_light /= np.linalg.norm(fill_light)
    color_tree = cKDTree(
        source_xyz, leafsize=32, compact_nodes=True, balanced_tree=True
    ) if color_mode == "source" else None

    for face_index, (delta_values, normal_values, corner_values) in enumerate(FACE_DEFINITIONS):
        delta = np.asarray(delta_values, dtype=np.int32)
        cells = exposed_cells(occupied, delta)
        if not len(cells):
            continue
        corners = np.asarray(corner_values, dtype=np.float64)
        local_vertices = origin + (cells[:, None, :] + corners[None, :, :]) * voxel_size
        world_vertices = (local_vertices.reshape(-1, 3) @ axes).astype(np.float32)

        local_normal = np.asarray(normal_values, dtype=np.float64)
        world_normal = local_normal @ axes
        world_normal /= np.linalg.norm(world_normal)
        world_normals = np.repeat(world_normal[None, :], len(world_vertices), axis=0).astype(
            np.float32
        )

        if color_tree is not None:
            face_axis = int(np.flatnonzero(delta)[0])
            local_centers = origin + (cells.astype(np.float64) + 0.5) * voxel_size
            local_centers[:, face_axis] = origin[face_axis] + (
                cells[:, face_axis] + (1 if delta[face_axis] > 0 else 0)
            ) * voxel_size
            world_centers = local_centers @ axes
            neighbor_count = min(16, len(source_xyz))
            distances, indices = color_tree.query(
                world_centers, k=neighbor_count, workers=workers
            )
            if neighbor_count == 1:
                distances = distances[:, None]
                indices = indices[:, None]
            weights = 1.0 / np.maximum(distances, voxel_size * 0.20)
            face_colors = np.sum(
                source_colors[indices].astype(np.float64) * weights[:, :, None],
                axis=1,
            ) / np.sum(weights, axis=1)[:, None]
            face_colors = np.clip(np.rint(face_colors), 0, 255).astype(np.uint8)
            # Four identical vertex colors make every exposed quad a genuinely
            # solid color patch instead of an interpolated point-grid pattern.
            colors = np.repeat(face_colors, 4, axis=0)
        else:
            diffuse = 0.72 * abs(np.dot(world_normal, key_light))
            diffuse += 0.28 * abs(np.dot(world_normal, fill_light))
            block_hash = (
                (cells[:, 0] * 73856093)
                ^ (cells[:, 1] * 19349663)
                ^ (cells[:, 2] * 83492791)
            )
            variation = ((block_hash & 7).astype(np.float32) - 3.5) * 1.15
            gray = np.clip(
                np.rint(174.0 + 52.0 * diffuse + variation), 156, 232
            ).astype(np.uint8)
            colors = np.repeat(np.repeat(gray, 4)[:, None], 3, axis=1)

        base = vertex_offset + np.arange(len(cells), dtype=np.int32) * 4
        faces = np.empty((len(cells) * 2, 3), dtype=np.int32)
        faces[0::2] = np.column_stack((base, base + 1, base + 2))
        faces[1::2] = np.column_stack((base, base + 2, base + 3))

        vertices_parts.append(world_vertices)
        normals_parts.append(world_normals)
        colors_parts.append(colors)
        faces_parts.append(faces)
        vertex_offset += len(world_vertices)
        print(
            f"Block face {face_index + 1}/6: {len(cells):,} quads",
            flush=True,
        )

    return (
        np.concatenate(vertices_parts),
        np.concatenate(normals_parts),
        np.concatenate(colors_parts),
        np.concatenate(faces_parts),
    )


def make_header(
    vertex_count: int,
    face_count: int,
    axes: np.ndarray,
    bounds: np.ndarray,
    voxel_size: float,
    color_mode: str,
) -> bytes:
    comments = [
        "comment Open-top Manhattan voxel block presentation mesh",
        f"comment voxel_size {voxel_size:.9g}",
        f"comment block_color_mode {color_mode}",
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
        + "property float x\n"
        + "property float y\n"
        + "property float z\n"
        + "property float nx\n"
        + "property float ny\n"
        + "property float nz\n"
        + "property uchar red\n"
        + "property uchar green\n"
        + "property uchar blue\n"
        + f"element face {face_count}\n"
        + "property list uchar int vertex_indices\n"
        + "end_header\n"
    ).encode("ascii")


def write_mesh(
    output: Path,
    vertices: np.ndarray,
    normals: np.ndarray,
    colors: np.ndarray,
    faces: np.ndarray,
    axes: np.ndarray,
    bounds: np.ndarray,
    voxel_size: float,
    color_mode: str,
) -> None:
    vertex_records = np.empty(len(vertices), dtype=VERTEX_DTYPE)
    vertex_records["x"], vertex_records["y"], vertex_records["z"] = vertices.T
    vertex_records["nx"], vertex_records["ny"], vertex_records["nz"] = normals.T
    vertex_records["red"], vertex_records["green"], vertex_records["blue"] = colors.T
    face_records = np.empty(len(faces), dtype=FACE_DTYPE)
    face_records["count"] = 3
    face_records["a"], face_records["b"], face_records["c"] = faces.T

    temporary = output.with_name(f".{output.name}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        with temporary.open("wb") as stream:
            stream.write(
                make_header(
                    len(vertices), len(faces), axes, bounds, voxel_size, color_mode
                )
            )
            vertex_records.tofile(stream)
            face_records.tofile(stream)
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a voxel block PLY mesh")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--axes", type=parse_axes, required=True)
    parser.add_argument("--bounds", type=parse_bounds, required=True)
    parser.add_argument("--voxel-size", type=float, default=0.10)
    parser.add_argument("--minimum-points", type=int, default=3)
    parser.add_argument("--minimum-component", type=int, default=4)
    parser.add_argument("--color-mode", choices=("gray", "source"), default="gray")
    parser.add_argument("--workers", type=int, default=14)
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
    if args.voxel_size <= 0 or args.minimum_points <= 0 or args.minimum_component <= 0:
        raise ValueError("voxel and filtering values must be positive")

    xyz, source_colors, _normals = load_openmvs_vertices(source)
    local_xyz = xyz.astype(np.float64) @ args.axes.T
    occupied, dimensions, inside_count, removed_voxels = build_occupancy(
        local_xyz,
        args.bounds,
        args.voxel_size,
        args.minimum_points,
        args.minimum_component,
    )
    print(f"Input points inside room: {inside_count:,}/{len(xyz):,}")
    print(f"Voxel grid: {dimensions.tolist()}")
    print(f"Occupied blocks: {np.count_nonzero(occupied):,}")
    print(f"Removed isolated blocks: {removed_voxels:,}")

    vertices, normals, colors, faces = make_mesh(
        occupied,
        args.bounds[:, 0],
        args.voxel_size,
        args.axes,
        xyz,
        source_colors,
        args.color_mode,
        args.workers,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    write_mesh(
        output,
        vertices,
        normals,
        colors,
        faces,
        args.axes,
        args.bounds,
        args.voxel_size,
        args.color_mode,
    )
    print(f"Vertices: {len(vertices):,}")
    print(f"Triangles: {len(faces):,}")
    print(f"Output: {output}")
    print(f"Size: {output.stat().st_size / 1024 / 1024:.2f} MiB")
    print(f"Elapsed: {time.perf_counter() - started:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
