from __future__ import annotations

import argparse
import mmap
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from uniformize_openmvs_ply import OUTPUT_VERTEX_DTYPE, load_openmvs_vertices


MAX_HEADER_BYTES = 64 * 1024


@dataclass(frozen=True)
class MeshHeader:
    vertex_count: int
    face_count: int
    data_offset: int
    vertex_properties: tuple[str, ...]
    face_properties: tuple[str, ...]


def read_mesh_header(source) -> MeshHeader:
    header_size = 0
    current_element: str | None = None
    vertex_count: int | None = None
    face_count: int | None = None
    vertex_properties: list[str] = []
    face_properties: list[str] = []
    lines: list[str] = []

    while header_size < MAX_HEADER_BYTES:
        raw_line = source.readline()
        if not raw_line:
            raise ValueError("网格 PLY 在 end_header 前意外结束。")
        header_size += len(raw_line)
        line = raw_line.decode("ascii").strip()
        lines.append(line)
        if line.startswith("element "):
            parts = line.split()
            if len(parts) != 3:
                raise ValueError(f"无法识别 element：{line}")
            current_element = parts[1]
            if current_element == "vertex":
                vertex_count = int(parts[2])
            elif current_element == "face":
                face_count = int(parts[2])
        elif line.startswith("property "):
            if current_element == "vertex":
                vertex_properties.append(line)
            elif current_element == "face":
                face_properties.append(line)
        elif line == "end_header":
            break
    else:
        raise ValueError(f"网格 PLY 文件头超过 {MAX_HEADER_BYTES} 字节。")

    if not lines or lines[0] != "ply":
        raise ValueError("输入不是 PLY。")
    if "format binary_little_endian 1.0" not in lines:
        raise ValueError("仅支持 binary_little_endian 1.0 网格 PLY。")
    if not vertex_count or not face_count:
        raise ValueError("网格 PLY 缺少有效顶点或面。")
    return MeshHeader(
        vertex_count,
        face_count,
        source.tell(),
        tuple(vertex_properties),
        tuple(face_properties),
    )


def load_triangle_mesh(path: Path) -> tuple[np.ndarray, np.ndarray]:
    expected_vertex_properties = (
        "property float32 x",
        "property float32 y",
        "property float32 z",
    )
    expected_face_properties = ("property list uint8 uint32 vertex_indices",)
    face_dtype = np.dtype([("count", "u1"), ("indices", "<u4", (3,))], align=False)

    with path.open("rb") as source:
        header = read_mesh_header(source)
        if header.vertex_properties != expected_vertex_properties:
            raise ValueError(f"不支持的网格顶点属性：{header.vertex_properties}")
        if header.face_properties != expected_face_properties:
            raise ValueError(f"不支持的网格面属性：{header.face_properties}")
        with mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
            vertex_bytes = header.vertex_count * 3 * 4
            face_offset = header.data_offset + vertex_bytes
            expected_size = face_offset + header.face_count * face_dtype.itemsize
            if expected_size != len(mapped):
                raise ValueError(
                    "网格不是固定三角面布局，或文件长度异常："
                    f"预期 {expected_size:,}，实际 {len(mapped):,} 字节。"
                )
            vertices = np.frombuffer(
                mapped,
                dtype="<f4",
                count=header.vertex_count * 3,
                offset=header.data_offset,
            ).reshape(-1, 3).copy()
            face_records = np.frombuffer(
                mapped,
                dtype=face_dtype,
                count=header.face_count,
                offset=face_offset,
            )
            if not np.all(face_records["count"] == 3):
                raise ValueError("网格包含非三角面。")
            faces = face_records["indices"].copy()
            del face_records
    return vertices, faces


def sample_mesh_surface(
    vertices: np.ndarray,
    faces: np.ndarray,
    target_points: int,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    v0 = vertices[faces[:, 0]]
    v1 = vertices[faces[:, 1]]
    v2 = vertices[faces[:, 2]]
    triangle_normals = np.cross(v1 - v0, v2 - v0)
    double_areas = np.linalg.norm(triangle_normals, axis=1)
    valid = np.isfinite(double_areas) & (double_areas > 1e-12)
    if not valid.all():
        removed = int(np.count_nonzero(~valid))
        print(f"已跳过 {removed:,} 个退化三角面。")
        faces = faces[valid]
        triangle_normals = triangle_normals[valid]
        double_areas = double_areas[valid]
    normal_lengths = double_areas[:, None]
    triangle_normals = (triangle_normals / normal_lengths).astype(np.float32)

    cumulative_area = np.cumsum(double_areas, dtype=np.float64)
    total_area = float(cumulative_area[-1])
    sample_positions = (np.arange(target_points, dtype=np.float64) + 0.5) * (
        total_area / target_points
    )
    selected_faces = np.searchsorted(cumulative_area, sample_positions, side="left")

    selected = faces[selected_faces]
    p0 = vertices[selected[:, 0]]
    p1 = vertices[selected[:, 1]]
    p2 = vertices[selected[:, 2]]
    rng = np.random.default_rng(seed)
    u = np.sqrt(rng.random(target_points, dtype=np.float32))
    v = rng.random(target_points, dtype=np.float32)
    weights0 = 1.0 - u
    weights1 = u * (1.0 - v)
    weights2 = u * v
    points = (
        p0 * weights0[:, None]
        + p1 * weights1[:, None]
        + p2 * weights2[:, None]
    ).astype(np.float32)
    normals = triangle_normals[selected_faces]
    return points, normals


def transfer_colors(
    reference_xyz: np.ndarray,
    reference_rgb: np.ndarray,
    query_xyz: np.ndarray,
    workers: int,
    batch_size: int,
) -> tuple[np.ndarray, np.ndarray]:
    print(f"正在为 {len(reference_xyz):,} 个参考点建立 KD-Tree…", flush=True)
    tree = cKDTree(reference_xyz, leafsize=32, compact_nodes=True, balanced_tree=True)
    colors = np.empty((len(query_xyz), 3), dtype=np.uint8)
    nearest_distances = np.empty(len(query_xyz), dtype=np.float32)

    for start in range(0, len(query_xyz), batch_size):
        end = min(start + batch_size, len(query_xyz))
        distances, indices = tree.query(query_xyz[start:end], k=4, workers=workers)
        distances = np.asarray(distances, dtype=np.float64)
        indices = np.asarray(indices)
        weights = 1.0 / np.maximum(distances, 1e-8) ** 2
        blended = np.sum(reference_rgb[indices].astype(np.float64) * weights[:, :, None], axis=1)
        blended /= np.sum(weights, axis=1)[:, None]
        colors[start:end] = np.clip(np.rint(blended), 0, 255).astype(np.uint8)
        nearest_distances[start:end] = distances[:, 0].astype(np.float32)
        print(f"颜色映射 {end:,}/{len(query_xyz):,}", flush=True)
    return colors, nearest_distances


def output_header(vertex_count: int, source_mesh: Path) -> bytes:
    return (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "comment Display-enhanced point cloud sampled from a hole-filled surface\n"
        f"comment source_mesh {source_mesh.name}\n"
        "comment RGB transferred by inverse-distance weighted 4-nearest neighbors\n"
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


def build_display_cloud(
    mesh_path: Path,
    color_reference_path: Path,
    output_path: Path,
    target_points: int,
    workers: int,
    batch_size: int,
    seed: int,
    force: bool,
) -> None:
    mesh_path = mesh_path.resolve()
    color_reference_path = color_reference_path.resolve()
    output_path = output_path.resolve()
    if not mesh_path.is_file():
        raise FileNotFoundError(f"找不到网格：{mesh_path}")
    if not color_reference_path.is_file():
        raise FileNotFoundError(f"找不到颜色参考点云：{color_reference_path}")
    if output_path in (mesh_path, color_reference_path):
        raise ValueError("输出不能覆盖输入文件。")
    if output_path.exists() and not force:
        raise FileExistsError(f"输出已存在；如需替换请添加 --force：{output_path}")
    if target_points <= 0 or batch_size <= 0:
        raise ValueError("目标点数和批大小必须大于 0。")

    started_at = time.perf_counter()
    vertices, faces = load_triangle_mesh(mesh_path)
    print(f"网格：{len(vertices):,} 顶点，{len(faces):,} 三角面")
    points, normals = sample_mesh_surface(vertices, faces, target_points, seed)
    del vertices, faces
    print(f"已按表面积均匀采样 {len(points):,} 点")

    reference_xyz, reference_rgb, _reference_normals = load_openmvs_vertices(
        color_reference_path
    )
    colors, nearest_distances = transfer_colors(
        reference_xyz,
        reference_rgb,
        points,
        workers,
        batch_size,
    )
    del reference_xyz, reference_rgb, _reference_normals

    distance_percentiles = np.percentile(nearest_distances, (50, 90, 95, 99, 100))
    print(
        "最近颜色参考距离 P50/P90/P95/P99/MAX："
        + " / ".join(f"{value:.5g}" for value in distance_percentiles)
    )

    records = np.zeros(len(points), dtype=OUTPUT_VERTEX_DTYPE)
    records["x"], records["y"], records["z"] = points.T
    records["red"], records["green"], records["blue"] = colors.T
    records["nx"], records["ny"], records["nz"] = normals.T

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    temporary_path.unlink(missing_ok=True)
    try:
        with temporary_path.open("wb") as output:
            output.write(output_header(len(records), mesh_path))
            records.tofile(output)
        os.replace(temporary_path, output_path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise

    print(f"输出：{output_path}")
    print(f"点数：{len(records):,}")
    print(f"文件大小：{output_path.stat().st_size / 1024 / 1024:.2f} MiB")
    print(f"耗时：{time.perf_counter() - started_at:.1f} 秒")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="从封洞网格表面均匀采样，并从彩色点云转移颜色，生成展示增强 PLY。"
    )
    parser.add_argument("mesh", type=Path, help="输入三角网格 PLY")
    parser.add_argument("color_reference", type=Path, help="颜色参考 OpenMVS PLY")
    parser.add_argument("output", type=Path, help="输出展示增强彩色 PLY")
    parser.add_argument("--target-points", type=int, default=1_600_000)
    parser.add_argument("--workers", type=int, default=-1)
    parser.add_argument("--batch-size", type=int, default=150_000)
    parser.add_argument("--seed", type=int, default=20260716)
    parser.add_argument("--force", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        build_display_cloud(
            args.mesh,
            args.color_reference,
            args.output,
            args.target_points,
            args.workers,
            args.batch_size,
            args.seed,
            args.force,
        )
    except (OSError, UnicodeDecodeError, ValueError, RuntimeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
