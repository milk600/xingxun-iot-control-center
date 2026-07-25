from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from uniformize_openmvs_ply import OUTPUT_VERTEX_DTYPE, load_openmvs_vertices


def parse_floats(value: str, expected: int, label: str) -> np.ndarray:
    try:
        result = np.asarray([float(part.strip()) for part in value.split(",")], dtype=np.float64)
    except ValueError as exc:
        raise ValueError(f"{label} 必须是逗号分隔的数字。") from exc
    if len(result) != expected:
        raise ValueError(f"{label} 需要 {expected} 个数字，实际为 {len(result)} 个。")
    return result


def orthonormal_frame(axis_values: np.ndarray) -> np.ndarray:
    axes = axis_values.reshape(3, 3).copy()
    axes[0] /= np.linalg.norm(axes[0])
    axes[1] -= axes[0] * np.dot(axes[1], axes[0])
    axes[1] /= np.linalg.norm(axes[1])
    axes[2] = np.cross(axes[0], axes[1])
    axes[2] /= np.linalg.norm(axes[2])
    axes[1] = np.cross(axes[2], axes[0])
    axes[1] /= np.linalg.norm(axes[1])
    return axes


def query_nearest_distances(
    tree: cKDTree, points: np.ndarray, workers: int, batch_size: int
) -> np.ndarray:
    distances = np.empty(len(points), dtype=np.float32)
    for start in range(0, len(points), batch_size):
        end = min(start + batch_size, len(points))
        batch_distances, _indices = tree.query(points[start:end], k=1, workers=workers)
        distances[start:end] = batch_distances.astype(np.float32)
    return distances


def sharpen_reliable_colors(
    xyz: np.ndarray,
    colors: np.ndarray,
    reliable: np.ndarray,
    amount: float,
    contrast: float,
    workers: int,
    batch_size: int,
) -> np.ndarray:
    result = colors.copy()
    reliable_indices = np.flatnonzero(reliable)
    if len(reliable_indices) < 16:
        return result
    reliable_xyz = xyz[reliable_indices]
    reliable_colors = colors[reliable_indices].astype(np.float32)
    tree = cKDTree(reliable_xyz, leafsize=32, compact_nodes=True, balanced_tree=True)
    for start in range(0, len(reliable_indices), batch_size):
        end = min(start + batch_size, len(reliable_indices))
        _distances, neighbors = tree.query(
            reliable_xyz[start:end], k=9, workers=workers
        )
        local_mean = reliable_colors[neighbors[:, 1:]].mean(axis=1)
        sharpened = reliable_colors[start:end] + amount * (
            reliable_colors[start:end] - local_mean
        )
        sharpened = (sharpened - 127.5) * contrast + 127.5
        result[reliable_indices[start:end]] = np.clip(
            np.rint(sharpened), 0, 255
        ).astype(np.uint8)
        print(f"真实区域锐化 {end:,}/{len(reliable_indices):,}", flush=True)
    return result


def dehaze_color_grade(
    colors: np.ndarray,
    reference_colors: np.ndarray,
    strength: float,
    saturation: float,
    gamma: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    reference = reference_colors.astype(np.float32)
    black = np.percentile(reference, 1.5, axis=0).astype(np.float32)
    white = np.percentile(reference, 98.5, axis=0).astype(np.float32)
    span = np.maximum(white - black, 24.0)

    original = colors.astype(np.float32)
    stretched = np.clip((original - black) * (255.0 / span), 0.0, 255.0)
    graded = original * (1.0 - strength) + stretched * strength
    graded = 255.0 * np.power(np.clip(graded / 255.0, 0.0, 1.0), gamma)
    luminance = (
        graded[:, 0] * 0.2126 + graded[:, 1] * 0.7152 + graded[:, 2] * 0.0722
    )
    graded = luminance[:, None] + saturation * (graded - luminance[:, None])
    return np.clip(np.rint(graded), 0, 255).astype(np.uint8), black, white


def block_mean_colors(
    points: np.ndarray,
    block_coordinates: np.ndarray,
    reference_tree: cKDTree,
    reference_colors: np.ndarray,
    workers: int,
    neighbor_count: int,
) -> tuple[np.ndarray, np.ndarray]:
    unique_blocks, inverse = np.unique(block_coordinates, axis=0, return_inverse=True)
    counts = np.bincount(inverse)
    centers = np.column_stack(
        [
            np.bincount(inverse, weights=points[:, dimension]) / counts
            for dimension in range(3)
        ]
    )
    k = min(neighbor_count, len(reference_colors))
    _distances, indices = reference_tree.query(centers, k=k, workers=workers)
    if k == 1:
        indices = indices[:, None]
    colors = np.rint(reference_colors[indices].astype(np.float64).mean(axis=1))
    return np.clip(colors, 0, 255).astype(np.uint8), inverse


def recolor_hole_blocks(
    xyz: np.ndarray,
    local_xyz: np.ndarray,
    colors: np.ndarray,
    hole_mask: np.ndarray,
    bounds: np.ndarray,
    block_size: float,
    reference_tree: cKDTree,
    reference_colors: np.ndarray,
    workers: int,
) -> np.ndarray:
    result = colors.copy()
    hole_indices = np.flatnonzero(hole_mask)
    if not len(hole_indices):
        return result
    blocks = np.floor((local_xyz[hole_indices] - bounds[:, 0]) / block_size).astype(np.int32)
    block_colors, inverse = block_mean_colors(
        xyz[hole_indices],
        blocks,
        reference_tree,
        reference_colors,
        workers,
        32,
    )
    result[hole_indices] = block_colors[inverse]
    print(
        f"纯色补洞：{len(hole_indices):,} 点，{len(block_colors):,} 个相邻均色块",
        flush=True,
    )
    return result


def snap_holes_to_room_planes(
    xyz: np.ndarray,
    local_xyz: np.ndarray,
    hole_mask: np.ndarray,
    axes: np.ndarray,
    bounds: np.ndarray,
    snap_distance: float,
) -> tuple[np.ndarray, np.ndarray, int]:
    distances = np.stack(
        [
            np.abs(local_xyz[:, 0] - bounds[0, 0]),
            np.abs(local_xyz[:, 0] - bounds[0, 1]),
            np.abs(local_xyz[:, 1] - bounds[1, 0]),
            np.abs(local_xyz[:, 1] - bounds[1, 1]),
            np.abs(local_xyz[:, 2] - bounds[2, 0]),
            np.abs(local_xyz[:, 2] - bounds[2, 1]),
        ],
        axis=1,
    )
    nearest_plane = distances.argmin(axis=1)
    nearest_distance = distances[np.arange(len(distances)), nearest_plane]
    in_footprint = np.ones(len(xyz), dtype=bool)
    margin = snap_distance
    for dimension in range(3):
        in_footprint &= local_xyz[:, dimension] >= bounds[dimension, 0] - margin
        in_footprint &= local_xyz[:, dimension] <= bounds[dimension, 1] + margin
    snap = hole_mask & in_footprint & (nearest_distance <= snap_distance)
    snap_indices = np.flatnonzero(snap)
    for plane in range(6):
        selected = snap_indices[nearest_plane[snap_indices] == plane]
        if not len(selected):
            continue
        dimension = plane // 2
        side = plane % 2
        local_xyz[selected, dimension] = bounds[dimension, side]
    xyz[snap_indices] = local_xyz[snap_indices] @ axes
    return xyz, local_xyz, len(snap_indices)


def make_plane_grid(
    axes: np.ndarray,
    bounds: np.ndarray,
    plane_dimension: int,
    side: int,
    spacing: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    other_dimensions = [dimension for dimension in range(3) if dimension != plane_dimension]
    values_a = np.arange(
        bounds[other_dimensions[0], 0],
        bounds[other_dimensions[0], 1] + spacing * 0.5,
        spacing,
        dtype=np.float64,
    )
    values_b = np.arange(
        bounds[other_dimensions[1], 0],
        bounds[other_dimensions[1], 1] + spacing * 0.5,
        spacing,
        dtype=np.float64,
    )
    grid_a, grid_b = np.meshgrid(values_a, values_b, indexing="ij")
    local = np.empty((grid_a.size, 3), dtype=np.float64)
    local[:, plane_dimension] = bounds[plane_dimension, side]
    local[:, other_dimensions[0]] = grid_a.ravel()
    local[:, other_dimensions[1]] = grid_b.ravel()
    world = (local @ axes).astype(np.float32)
    inward_sign = 1.0 if side == 0 else -1.0
    normal = (axes[plane_dimension] * inward_sign).astype(np.float32)
    normals = np.repeat(normal[None, :], len(world), axis=0)
    return world, local, normals


def add_missing_room_shell(
    xyz: np.ndarray,
    axes: np.ndarray,
    bounds: np.ndarray,
    spacing: float,
    gap_distance: float,
    block_size: float,
    reference_xyz: np.ndarray,
    reference_colors: np.ndarray,
    reference_tree: cKDTree,
    workers: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    existing_tree = cKDTree(xyz, leafsize=32, compact_nodes=True, balanced_tree=True)
    reference_local = reference_xyz @ axes.T
    shell_points: list[np.ndarray] = []
    shell_colors: list[np.ndarray] = []
    shell_normals: list[np.ndarray] = []

    for plane in range(6):
        dimension = plane // 2
        side = plane % 2
        world, local, normals = make_plane_grid(axes, bounds, dimension, side, spacing)
        distances, _indices = existing_tree.query(world, k=1, workers=workers)
        missing = distances > gap_distance
        if not np.any(missing):
            continue
        world = world[missing]
        local = local[missing]
        normals = normals[missing]

        plane_band = max(spacing * 4.0, 0.20)
        on_plane = np.abs(reference_local[:, dimension] - bounds[dimension, side]) <= plane_band
        for other in range(3):
            if other == dimension:
                continue
            on_plane &= reference_local[:, other] >= bounds[other, 0] - plane_band
            on_plane &= reference_local[:, other] <= bounds[other, 1] + plane_band
        if np.count_nonzero(on_plane) >= 64:
            color_tree = cKDTree(
                reference_xyz[on_plane], leafsize=24, compact_nodes=True, balanced_tree=True
            )
            color_values = reference_colors[on_plane]
        else:
            color_tree = reference_tree
            color_values = reference_colors

        tile_dimensions = [item for item in range(3) if item != dimension]
        tiles = np.column_stack(
            [
                np.full(len(local), plane, dtype=np.int32),
                np.floor(
                    (local[:, tile_dimensions[0]] - bounds[tile_dimensions[0], 0])
                    / block_size
                ).astype(np.int32),
                np.floor(
                    (local[:, tile_dimensions[1]] - bounds[tile_dimensions[1], 0])
                    / block_size
                ).astype(np.int32),
            ]
        )
        colors, inverse = block_mean_colors(
            world,
            tiles,
            color_tree,
            color_values,
            workers,
            48,
        )
        shell_points.append(world)
        shell_colors.append(colors[inverse])
        shell_normals.append(normals)
        print(
            f"房间平面 {plane + 1}/6：补入 {len(world):,} 点，{len(colors):,} 个纯色色块",
            flush=True,
        )

    if not shell_points:
        return (
            np.empty((0, 3), dtype=np.float32),
            np.empty((0, 3), dtype=np.uint8),
            np.empty((0, 3), dtype=np.float32),
        )
    return (
        np.concatenate(shell_points),
        np.concatenate(shell_colors),
        np.concatenate(shell_normals),
    )


def output_header(vertex_count: int, axes: np.ndarray, bounds: np.ndarray) -> bytes:
    comments = [
        "comment Final presentation cloud: pure-color hole blocks, sharpened and dehazed RGB, Manhattan room shell",
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


def write_output(
    output_path: Path,
    xyz: np.ndarray,
    colors: np.ndarray,
    normals: np.ndarray,
    axes: np.ndarray,
    bounds: np.ndarray,
    force: bool,
) -> None:
    if output_path.exists() and not force:
        raise FileExistsError(f"输出已存在；如需替换请添加 --force：{output_path}")
    records = np.zeros(len(xyz), dtype=OUTPUT_VERTEX_DTYPE)
    records["x"], records["y"], records["z"] = xyz.T
    records["red"], records["green"], records["blue"] = colors.T
    records["nx"], records["ny"], records["nz"] = normals.T
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    temporary_path.unlink(missing_ok=True)
    try:
        with temporary_path.open("wb") as output:
            output.write(output_header(len(records), axes, bounds))
            records.tofile(output)
        os.replace(temporary_path, output_path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def finalize(args: argparse.Namespace) -> None:
    started_at = time.perf_counter()
    source_path = args.source.resolve()
    reference_path = args.reference.resolve()
    output_path = args.output.resolve()
    if not source_path.is_file() or not reference_path.is_file():
        raise FileNotFoundError("输入展示点云或颜色参考点云不存在。")
    if output_path in (source_path, reference_path):
        raise ValueError("输出不能覆盖输入点云。")

    axes = orthonormal_frame(parse_floats(args.axes, 9, "axes"))
    bounds = parse_floats(args.bounds, 6, "bounds").reshape(3, 2)
    if np.any(bounds[:, 1] <= bounds[:, 0]):
        raise ValueError("每一轴的上界必须大于下界。")

    xyz, colors, normals = load_openmvs_vertices(source_path)
    reference_xyz, reference_colors, _reference_normals = load_openmvs_vertices(
        reference_path
    )
    print(f"展示点云：{len(xyz):,} 点；真实颜色参考：{len(reference_xyz):,} 点")
    reference_tree = cKDTree(
        reference_xyz, leafsize=32, compact_nodes=True, balanced_tree=True
    )
    nearest = query_nearest_distances(
        reference_tree, xyz, args.workers, args.batch_size
    )
    hole_mask = nearest > args.hole_threshold
    print(
        f"低置信度补洞点：{np.count_nonzero(hole_mask):,} "
        f"({np.mean(hole_mask) * 100:.1f}%)"
    )

    local_xyz = xyz.astype(np.float64) @ axes.T
    xyz, local_xyz, snapped = snap_holes_to_room_planes(
        xyz,
        local_xyz,
        hole_mask,
        axes,
        bounds,
        args.snap_distance,
    )
    print(f"吸附到房间几何框架：{snapped:,} 点")

    reliable = ~hole_mask
    final_colors = sharpen_reliable_colors(
        xyz,
        colors,
        reliable,
        args.sharpen_amount,
        args.contrast,
        args.workers,
        args.batch_size,
    )
    final_colors = recolor_hole_blocks(
        xyz,
        local_xyz,
        final_colors,
        hole_mask,
        bounds,
        args.block_size,
        reference_tree,
        reference_colors,
        args.workers,
    )

    shell_xyz, shell_colors, shell_normals = add_missing_room_shell(
        xyz,
        axes,
        bounds,
        args.shell_spacing,
        args.shell_gap,
        args.block_size,
        reference_xyz,
        reference_colors,
        reference_tree,
        args.workers,
    )
    if len(shell_xyz):
        xyz = np.concatenate((xyz, shell_xyz))
        final_colors = np.concatenate((final_colors, shell_colors))
        normals = np.concatenate((normals, shell_normals))

    final_colors, black_point, white_point = dehaze_color_grade(
        final_colors,
        colors[reliable],
        args.dehaze_strength,
        args.saturation,
        args.gamma,
    )
    print(
        "去灰雾黑场/白场："
        f"{np.rint(black_point).astype(int).tolist()} / "
        f"{np.rint(white_point).astype(int).tolist()}；"
        f"强度 {args.dehaze_strength:.2f}，饱和度 {args.saturation:.2f}"
    )

    write_output(output_path, xyz, final_colors, normals, axes, bounds, args.force)
    print(f"最终点数：{len(xyz):,}（框架补点 {len(shell_xyz):,}）")
    print(f"输出：{output_path}")
    print(f"文件大小：{output_path.stat().st_size / 1024 / 1024:.2f} MiB")
    print(f"耗时：{time.perf_counter() - started_at:.1f} 秒")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="为展示点云执行纯色补洞、颜色锐化和 Manhattan 房间框架约束。"
    )
    parser.add_argument("source", type=Path, help="展示增强 PLY")
    parser.add_argument("reference", type=Path, help="真实颜色参考 PLY")
    parser.add_argument("output", type=Path, help="最终展示 PLY")
    parser.add_argument("--axes", required=True, help="三条轴的 9 个逗号分隔数值")
    parser.add_argument("--bounds", required=True, help="三轴 min,max 的 6 个逗号分隔数值")
    parser.add_argument("--hole-threshold", type=float, default=0.055)
    parser.add_argument("--snap-distance", type=float, default=0.30)
    parser.add_argument("--shell-spacing", type=float, default=0.05)
    parser.add_argument("--shell-gap", type=float, default=0.065)
    parser.add_argument("--block-size", type=float, default=0.60)
    parser.add_argument("--sharpen-amount", type=float, default=0.72)
    parser.add_argument("--contrast", type=float, default=1.08)
    parser.add_argument("--dehaze-strength", type=float, default=0.72)
    parser.add_argument("--saturation", type=float, default=1.16)
    parser.add_argument("--gamma", type=float, default=0.96)
    parser.add_argument("--workers", type=int, default=14)
    parser.add_argument("--batch-size", type=int, default=120_000)
    parser.add_argument("--force", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        finalize(args)
    except (OSError, UnicodeDecodeError, ValueError, RuntimeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
