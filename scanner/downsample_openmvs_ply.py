from __future__ import annotations

import argparse
import mmap
import os
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path


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
XYZ_RGB_VERTEX = struct.Struct("<fffBBB")


@dataclass(frozen=True)
class PlyHeader:
    vertex_count: int
    data_offset: int
    vertex_properties: tuple[str, ...]


def read_header(source) -> PlyHeader:
    lines: list[str] = []
    header_size = 0
    vertex_count: int | None = None
    vertex_properties: list[str] = []
    current_element: str | None = None

    while header_size < MAX_HEADER_BYTES:
        raw_line = source.readline()
        if not raw_line:
            raise ValueError("PLY 文件在 end_header 前意外结束。")
        header_size += len(raw_line)
        try:
            line = raw_line.decode("ascii").strip()
        except UnicodeDecodeError as exc:
            raise ValueError("PLY 文件头不是 ASCII。") from exc
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
        raise ValueError("仅支持 OpenMVS 的 binary_little_endian 1.0 PLY。")
    if vertex_count is None or vertex_count <= 0:
        raise ValueError("PLY 文件没有有效顶点。")

    return PlyHeader(
        vertex_count=vertex_count,
        data_offset=source.tell(),
        vertex_properties=tuple(vertex_properties),
    )


def output_header(vertex_count: int) -> bytes:
    return (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "comment Generated from the original OpenMVS dense point cloud; RGB preserved\n"
        f"element vertex {vertex_count}\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "property uchar red\n"
        "property uchar green\n"
        "property uchar blue\n"
        "end_header\n"
    ).encode("ascii")


def downsample(source_path: Path, output_path: Path, target_points: int, force: bool) -> None:
    source_path = source_path.resolve()
    output_path = output_path.resolve()
    if source_path == output_path:
        raise ValueError("输出路径不能覆盖输入点云。")
    if not source_path.is_file():
        raise FileNotFoundError(f"找不到输入点云：{source_path}")
    if target_points <= 0:
        raise ValueError("目标点数必须大于 0。")
    if output_path.exists() and not force:
        raise FileExistsError(f"输出已存在；如需重建请添加 --force：{output_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    if temporary_path.exists():
        temporary_path.unlink()

    started_at = time.perf_counter()
    try:
        with source_path.open("rb") as source:
            header = read_header(source)
            if header.vertex_properties != OPENMVS_VERTEX_PROPERTIES:
                actual = "\n".join(header.vertex_properties)
                raise ValueError(
                    "输入不是当前支持的 OpenMVS 稠密点云顶点布局。\n"
                    f"实际属性：\n{actual}"
                )
            if target_points > header.vertex_count:
                raise ValueError(
                    f"目标点数 {target_points:,} 超过输入点数 {header.vertex_count:,}。"
                )

            with mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as mapped, temporary_path.open(
                "wb", buffering=8 * 1024 * 1024
            ) as output:
                output.write(output_header(target_points))
                position = header.data_offset
                accumulator = 0
                selected = 0
                output_buffer = bytearray()
                source_size = len(mapped)

                for index in range(header.vertex_count):
                    fixed_end = position + OPENMVS_FIXED_VERTEX.size
                    if fixed_end > source_size:
                        raise ValueError(f"输入点云在第 {index:,} 个顶点处截断。")
                    x, y, z, red, green, blue, _nx, _ny, _nz = OPENMVS_FIXED_VERTEX.unpack_from(
                        mapped, position
                    )
                    position = fixed_end

                    if position >= source_size:
                        raise ValueError(f"输入点云在第 {index:,} 个视图索引列表处截断。")
                    view_count = mapped[position]
                    position += 1 + view_count * 4
                    if position >= source_size:
                        raise ValueError(f"输入点云在第 {index:,} 个视图权重列表处截断。")
                    weight_count = mapped[position]
                    position += 1 + weight_count * 4
                    if position > source_size:
                        raise ValueError(f"输入点云在第 {index:,} 个顶点列表数据处截断。")

                    accumulator += target_points
                    if accumulator >= header.vertex_count:
                        accumulator -= header.vertex_count
                        output_buffer.extend(XYZ_RGB_VERTEX.pack(x, y, z, red, green, blue))
                        selected += 1

                    if len(output_buffer) >= 8 * 1024 * 1024:
                        output.write(output_buffer)
                        output_buffer.clear()
                    if (index + 1) % 1_000_000 == 0:
                        elapsed = time.perf_counter() - started_at
                        print(
                            f"已扫描 {index + 1:,}/{header.vertex_count:,} 点，"
                            f"已保留 {selected:,} 点，用时 {elapsed:.1f} 秒",
                            flush=True,
                        )

                if output_buffer:
                    output.write(output_buffer)
                if selected != target_points:
                    raise RuntimeError(
                        f"降采样点数不一致：期望 {target_points:,}，实际 {selected:,}。"
                    )

        os.replace(temporary_path, output_path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise

    elapsed = time.perf_counter() - started_at
    print(f"完成：{output_path}")
    print(f"点数：{target_points:,}")
    print(f"大小：{output_path.stat().st_size:,} 字节")
    print(f"耗时：{elapsed:.1f} 秒")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="从 OpenMVS 稠密 PLY 中均匀保留 XYZ+RGB，生成网页友好的彩色点云。"
    )
    parser.add_argument("source", type=Path, help="OpenMVS scene_cpu_dense.ply")
    parser.add_argument("output", type=Path, help="输出 binary PLY")
    parser.add_argument(
        "--target-points",
        type=int,
        default=2_000_000,
        help="输出点数，默认 2,000,000（当前网页上限）",
    )
    parser.add_argument("--force", action="store_true", help="允许替换已有输出文件")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        downsample(args.source, args.output, args.target_points, args.force)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
