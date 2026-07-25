from __future__ import annotations

import argparse
import mmap
import os
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np


MAX_HEADER_BYTES = 64 * 1024
OPENMVS_VERTEX_PROPERTIES = (
    "property float32 x",
    "property float32 y",
    "property float32 z",
    "property uint8 red",
    "property uint8 green",
    "property uint8 blue",
    "property float32 nx",
    "property float32 ny",
    "property float32 nz",
    "property list uint8 uint32 view_indices",
    "property list uint8 float32 view_weights",
)
OPENMVS_FIXED_VERTEX = struct.Struct("<fffBBBfff")
OUTPUT_VERTEX_DTYPE = np.dtype(
    [
        ("x", "<f4"),
        ("y", "<f4"),
        ("z", "<f4"),
        ("red", "u1"),
        ("green", "u1"),
        ("blue", "u1"),
        ("nx", "<f4"),
        ("ny", "<f4"),
        ("nz", "<f4"),
        ("view_count", "u1"),
        ("weight_count", "u1"),
    ],
    align=False,
)


@dataclass(frozen=True)
class PlyHeader:
    vertex_count: int
    data_offset: int
    vertex_properties: tuple[str, ...]


def read_header(source) -> PlyHeader:
    header_size = 0
    lines: list[str] = []
    current_element: str | None = None
    vertex_count: int | None = None
    vertex_properties: list[str] = []

    while header_size < MAX_HEADER_BYTES:
        raw_line = source.readline()
        if not raw_line:
            raise ValueError("PLY 文件在 end_header 前意外结束。")
        header_size += len(raw_line)
        line = raw_line.decode("ascii").strip()
        lines.append(line)
        if line.startswith("element "):
            parts = line.split()
            if len(parts) != 3:
                raise ValueError(f"无法识别 PLY element：{line}")
            current_element = parts[1]
            if current_element == "vertex":
                vertex_count = int(parts[2])
        elif line.startswith("property ") and current_element == "vertex":
            vertex_properties.append(line)
        elif line == "end_header":
            break
    else:
        raise ValueError(f"PLY 文件头超过 {MAX_HEADER_BYTES} 字节。")

    if not lines or lines[0] != "ply":
        raise ValueError("文件不是 PLY。")
    if "format binary_little_endian 1.0" not in lines:
        raise ValueError("仅支持 OpenMVS binary_little_endian 1.0 PLY。")
    if vertex_count is None or vertex_count <= 0:
        raise ValueError("PLY 文件没有有效顶点。")
    return PlyHeader(vertex_count, source.tell(), tuple(vertex_properties))


def output_header(vertex_count: int, voxel_size: float) -> bytes:
    return (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "comment Spatial voxel centroid sampling; RGB and normals preserved\n"
        f"comment voxel_size {voxel_size:.9g}\n"
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


def load_openmvs_vertices(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    with path.open("rb") as source:
        header = read_header(source)
        if header.vertex_properties != OPENMVS_VERTEX_PROPERTIES:
            actual = "\n".join(header.vertex_properties)
            raise ValueError(
                "输入不是受支持的 OpenMVS 稠密点云顶点布局。\n"
                f"实际属性：\n{actual}"
            )
        xyz = np.empty((header.vertex_count, 3), dtype=np.float32)
        rgb = np.empty((header.vertex_count, 3), dtype=np.uint8)
        normals = np.empty((header.vertex_count, 3), dtype=np.float32)
        with mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
            position = header.data_offset
            source_size = len(mapped)
            for index in range(header.vertex_count):
                fixed_end = position + OPENMVS_FIXED_VERTEX.size
                if fixed_end > source_size:
                    raise ValueError(f"输入点云在第 {index:,} 个顶点处截断。")
                values = OPENMVS_FIXED_VERTEX.unpack_from(mapped, position)
                xyz[index] = values[0:3]
                rgb[index] = values[3:6]
                normals[index] = values[6:9]
                position = fixed_end

                if position >= source_size:
                    raise ValueError(f"第 {index:,} 个顶点的视图索引列表缺失。")
                view_count = mapped[position]
                position += 1 + view_count * 4
                if position >= source_size:
                    raise ValueError(f"第 {index:,} 个顶点的视图权重列表缺失。")
                weight_count = mapped[position]
                position += 1 + weight_count * 4
                if position > source_size:
                    raise ValueError(f"第 {index:,} 个顶点的列表数据截断。")

                if (index + 1) % 1_000_000 == 0:
                    print(f"已读取 {index + 1:,}/{header.vertex_count:,} 点", flush=True)

    valid = np.isfinite(xyz).all(axis=1) & np.isfinite(normals).all(axis=1)
    if not valid.all():
        print(f"已剔除 {np.count_nonzero(~valid):,} 个非有限坐标或法线点。")
        xyz, rgb, normals = xyz[valid], rgb[valid], normals[valid]
    return xyz, rgb, normals


def voxel_keys(
    xyz: np.ndarray, voxel_size: float, origin: np.ndarray
) -> tuple[np.ndarray, np.ndarray, tuple[int, int, int]]:
    cells = np.floor((xyz - origin) / voxel_size).astype(np.int64)
    dimensions_array = cells.max(axis=0) + 1
    dimensions = tuple(int(value) for value in dimensions_array)
    product = dimensions[0] * dimensions[1] * dimensions[2]
    if product >= np.iinfo(np.int64).max:
        raise OverflowError("体素网格索引超出 int64 范围，请增大体素尺寸。")
    keys = (cells[:, 0] * dimensions[1] + cells[:, 1]) * dimensions[2] + cells[:, 2]
    return keys, cells, dimensions


def choose_voxel_size(xyz: np.ndarray, target_points: int) -> float:
    if target_points >= len(xyz):
        raise ValueError("目标点数必须小于输入点数，才能执行空间均匀化。")
    robust_low = np.percentile(xyz, 0.1, axis=0)
    robust_high = np.percentile(xyz, 99.9, axis=0)
    diagonal = float(np.linalg.norm(robust_high - robust_low))
    if diagonal <= 0:
        raise ValueError("点云包围盒无有效尺寸。")

    origin = xyz.min(axis=0).astype(np.float64)
    voxel_size = diagonal / np.sqrt(target_points)
    for _ in range(8):
        keys, _cells, _dimensions = voxel_keys(xyz, voxel_size, origin)
        occupied = int(np.unique(keys).size)
        ratio = occupied / target_points
        print(f"体素尺寸 {voxel_size:.7g}：预计 {occupied:,} 个空间单元")
        if 0.98 <= ratio <= 1.02:
            break
        voxel_size *= max(0.55, min(1.8, np.sqrt(ratio)))
    return voxel_size


def remove_isolated_singletons(
    unique_keys: np.ndarray,
    group_cells: np.ndarray,
    group_counts: np.ndarray,
    dimensions: tuple[int, int, int],
) -> np.ndarray:
    keep = np.ones(len(unique_keys), dtype=bool)
    candidate_indices = np.flatnonzero(group_counts == 1)
    if not len(candidate_indices):
        return keep

    cells = group_cells[candidate_indices]
    has_neighbor = np.zeros(len(candidate_indices), dtype=bool)
    dim_y, dim_z = dimensions[1], dimensions[2]
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if dx == dy == dz == 0:
                    continue
                valid = (
                    (cells[:, 0] + dx >= 0)
                    & (cells[:, 0] + dx < dimensions[0])
                    & (cells[:, 1] + dy >= 0)
                    & (cells[:, 1] + dy < dimensions[1])
                    & (cells[:, 2] + dz >= 0)
                    & (cells[:, 2] + dz < dimensions[2])
                    & ~has_neighbor
                )
                active = np.flatnonzero(valid)
                if not len(active):
                    continue
                neighbor_cells = cells[active] + np.array((dx, dy, dz), dtype=np.int64)
                neighbor_keys = (
                    (neighbor_cells[:, 0] * dim_y + neighbor_cells[:, 1]) * dim_z
                    + neighbor_cells[:, 2]
                )
                positions = np.searchsorted(unique_keys, neighbor_keys)
                found = positions < len(unique_keys)
                found[found] &= unique_keys[positions[found]] == neighbor_keys[found]
                has_neighbor[active[found]] = True
    keep[candidate_indices[~has_neighbor]] = False
    return keep


def uniformize(
    source_path: Path,
    output_path: Path,
    target_points: int,
    voxel_size: float | None,
    force: bool,
) -> None:
    source_path = source_path.resolve()
    output_path = output_path.resolve()
    if source_path == output_path:
        raise ValueError("输出路径不能覆盖输入点云。")
    if not source_path.is_file():
        raise FileNotFoundError(f"找不到输入点云：{source_path}")
    if target_points <= 0:
        raise ValueError("目标点数必须大于 0。")
    if output_path.exists() and not force:
        raise FileExistsError(f"输出已存在；如需替换请添加 --force：{output_path}")

    started_at = time.perf_counter()
    xyz, rgb, normals = load_openmvs_vertices(source_path)
    if voxel_size is None:
        voxel_size = choose_voxel_size(xyz, target_points)
    if voxel_size <= 0:
        raise ValueError("体素尺寸必须大于 0。")

    origin = xyz.min(axis=0).astype(np.float64)
    keys, cells, dimensions = voxel_keys(xyz, voxel_size, origin)
    order = np.argsort(keys, kind="stable")
    sorted_keys = keys[order]
    starts = np.r_[0, np.flatnonzero(np.diff(sorted_keys)) + 1]
    unique_keys = sorted_keys[starts]
    counts = np.diff(np.r_[starts, len(order)]).astype(np.int64)
    group_cells = cells[order[starts]]

    print(f"空间合并前：{len(xyz):,} 点")
    print(f"占用体素：{len(unique_keys):,} 个")
    sums_xyz = np.add.reduceat(xyz[order].astype(np.float64), starts, axis=0)
    sums_rgb = np.add.reduceat(rgb[order].astype(np.float64), starts, axis=0)
    sums_normals = np.add.reduceat(normals[order].astype(np.float64), starts, axis=0)
    centroids = (sums_xyz / counts[:, None]).astype(np.float32)
    colors = np.clip(np.rint(sums_rgb / counts[:, None]), 0, 255).astype(np.uint8)
    normal_lengths = np.linalg.norm(sums_normals, axis=1)
    valid_normals = normal_lengths > 1e-12
    averaged_normals = np.zeros_like(sums_normals, dtype=np.float32)
    averaged_normals[valid_normals] = (
        sums_normals[valid_normals] / normal_lengths[valid_normals, None]
    ).astype(np.float32)

    keep = remove_isolated_singletons(unique_keys, group_cells, counts, dimensions)
    removed = int(np.count_nonzero(~keep))
    centroids, colors, averaged_normals = centroids[keep], colors[keep], averaged_normals[keep]
    print(f"孤立单点体素：移除 {removed:,} 个")
    print(f"均匀化后：{len(centroids):,} 点")

    records = np.zeros(len(centroids), dtype=OUTPUT_VERTEX_DTYPE)
    records["x"], records["y"], records["z"] = centroids.T
    records["red"], records["green"], records["blue"] = colors.T
    records["nx"], records["ny"], records["nz"] = averaged_normals.T

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    temporary_path.unlink(missing_ok=True)
    try:
        with temporary_path.open("wb") as output:
            output.write(output_header(len(records), voxel_size))
            records.tofile(output)
        os.replace(temporary_path, output_path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise

    elapsed = time.perf_counter() - started_at
    print(f"输出：{output_path}")
    print(f"文件大小：{output_path.stat().st_size / 1024 / 1024:.2f} MiB")
    print(f"体素尺寸：{voxel_size:.9g}")
    print(f"耗时：{elapsed:.1f} 秒")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="对 OpenMVS 彩色 PLY 做空间体素均匀化与孤立点清理。"
    )
    parser.add_argument("source", type=Path, help="输入 OpenMVS scene_cpu_dense.ply")
    parser.add_argument("output", type=Path, help="输出均匀化 binary PLY")
    parser.add_argument(
        "--target-points",
        type=int,
        default=1_800_000,
        help="自动体素尺寸的目标点数，默认 1,800,000",
    )
    parser.add_argument(
        "--voxel-size",
        type=float,
        help="手动指定体素尺寸；设置后忽略自动目标点数",
    )
    parser.add_argument("--force", action="store_true", help="允许替换已有输出")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        uniformize(
            args.source,
            args.output,
            args.target_points,
            args.voxel_size,
            args.force,
        )
    except (OSError, UnicodeDecodeError, ValueError, RuntimeError, OverflowError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
