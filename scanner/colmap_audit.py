"""Read-only quality audit for COLMAP sparse reconstructions.

The parser intentionally has no dependency on COLMAP or third-party Python
packages.  It supports the binary and text model formats written by COLMAP and
only reads the image names and point-track statistics needed by the audit.
"""

from __future__ import annotations

import json
import math
import re
import struct
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO, Iterable


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
_IMAGE_RECORD = struct.Struct("<i7dI")
_POINT_RECORD = struct.Struct("<Q3d3BdQ")
_UINT64 = struct.Struct("<Q")


class SparseAuditError(RuntimeError):
    """A malformed or incomplete sparse model that cannot be audited."""


@dataclass(frozen=True)
class TimelineGap:
    count: int
    start: str | None
    end: str | None


@dataclass(frozen=True)
class ModelAudit:
    model: str
    registered_images: int
    registration_ratio: float
    point_count: int
    observation_count: int
    average_track_length: float | None
    mean_reprojection_error_px: float | None
    max_unregistered_gap: TimelineGap
    missing_source_images: int
    passes_registration: bool
    passes_reprojection_error: bool
    passes_track_length: bool

    @property
    def passes(self) -> bool:
        return (
            self.passes_registration
            and self.passes_reprojection_error
            and self.passes_track_length
        )


@dataclass(frozen=True)
class SparseAudit:
    project: str
    total_frames: int
    unique_registered_images: int
    unique_registration_ratio: float
    thresholds: dict[str, float]
    models: tuple[ModelAudit, ...]
    selected_model: str

    @property
    def selected(self) -> ModelAudit:
        for model in self.models:
            if model.model == self.selected_model:
                return model
        raise SparseAuditError(f"审计结果中找不到所选模型：{self.selected_model}")

    @property
    def passes(self) -> bool:
        return self.selected.passes

    def to_dict(self) -> dict[str, object]:
        result = asdict(self)
        result["passes"] = self.passes
        for model, serialized in zip(self.models, result["models"], strict=True):
            serialized["passes"] = model.passes
        return result

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)


@dataclass(frozen=True)
class _PointStatistics:
    point_count: int
    observation_count: int
    average_track_length: float | None
    mean_reprojection_error_px: float | None


def _read_exact(handle: BinaryIO, size: int, label: str) -> bytes:
    data = handle.read(size)
    if len(data) != size:
        raise SparseAuditError(f"COLMAP {label} 数据不完整。")
    return data


def _read_c_string(handle: BinaryIO, label: str) -> str:
    value = bytearray()
    while True:
        byte = handle.read(1)
        if not byte:
            raise SparseAuditError(f"COLMAP {label} 中的图像名称缺少结尾。")
        if byte == b"\x00":
            break
        value.extend(byte)
        if len(value) > 1024 * 1024:
            raise SparseAuditError(f"COLMAP {label} 中的图像名称异常过长。")
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SparseAuditError(f"COLMAP {label} 中的图像名称不是 UTF-8。") from error


def _skip_checked(handle: BinaryIO, size: int, file_size: int, label: str) -> None:
    if size < 0 or handle.tell() + size > file_size:
        raise SparseAuditError(f"COLMAP {label} 中的记录长度超出文件范围。")
    handle.seek(size, 1)


def read_registered_image_names(model: Path) -> tuple[str, ...]:
    """Return registered image names from ``images.bin`` or ``images.txt``."""

    binary = model / "images.bin"
    if binary.is_file():
        file_size = binary.stat().st_size
        try:
            with binary.open("rb") as handle:
                count = _UINT64.unpack(_read_exact(handle, 8, "images.bin"))[0]
                names: list[str] = []
                for _ in range(count):
                    _read_exact(handle, _IMAGE_RECORD.size, "images.bin")
                    names.append(_read_c_string(handle, "images.bin"))
                    point_count = _UINT64.unpack(
                        _read_exact(handle, 8, "images.bin")
                    )[0]
                    _skip_checked(handle, point_count * 24, file_size, "images.bin")
                return tuple(names)
        except OSError as error:
            raise SparseAuditError(f"无法读取 {binary}：{error}") from error

    text = model / "images.txt"
    if not text.is_file():
        raise SparseAuditError(f"模型缺少 images.bin/images.txt：{model}")
    try:
        lines = text.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise SparseAuditError(f"无法读取 {text}：{error}") from error

    names: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split(maxsplit=9)
        if len(fields) != 10:
            raise SparseAuditError(f"COLMAP images.txt 图像行格式无效：{line[:120]}")
        try:
            int(fields[0])
            [float(value) for value in fields[1:8]]
            int(fields[8])
        except ValueError as error:
            raise SparseAuditError(f"COLMAP images.txt 图像行包含无效数字。") from error
        names.append(fields[9])
        # Every image record is followed by one POINTS2D line.  It may be empty.
        if index < len(lines):
            index += 1
    return tuple(names)


def read_point_statistics(model: Path) -> _PointStatistics:
    """Read point count, tracks and COLMAP's mean per-point error."""

    binary = model / "points3D.bin"
    if binary.is_file():
        file_size = binary.stat().st_size
        try:
            with binary.open("rb") as handle:
                count = _UINT64.unpack(_read_exact(handle, 8, "points3D.bin"))[0]
                observations = 0
                error_sum = 0.0
                for _ in range(count):
                    fields = _POINT_RECORD.unpack(
                        _read_exact(handle, _POINT_RECORD.size, "points3D.bin")
                    )
                    error = float(fields[-2])
                    track_length = int(fields[-1])
                    if not math.isfinite(error) or error < 0:
                        raise SparseAuditError("COLMAP points3D.bin 包含无效重投影误差。")
                    observations += track_length
                    error_sum += error
                    _skip_checked(
                        handle, track_length * 8, file_size, "points3D.bin"
                    )
        except OSError as error:
            raise SparseAuditError(f"无法读取 {binary}：{error}") from error
        return _point_statistics(int(count), observations, error_sum)

    text = model / "points3D.txt"
    if not text.is_file():
        raise SparseAuditError(f"模型缺少 points3D.bin/points3D.txt：{model}")
    point_count = 0
    observations = 0
    error_sum = 0.0
    try:
        lines = text.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise SparseAuditError(f"无法读取 {text}：{error}") from error
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split()
        if len(fields) < 8 or (len(fields) - 8) % 2:
            raise SparseAuditError("COLMAP points3D.txt 点记录格式无效。")
        try:
            error = float(fields[7])
            track_values = [int(value) for value in fields[8:]]
        except ValueError as exc:
            raise SparseAuditError("COLMAP points3D.txt 点记录包含无效数字。") from exc
        if not math.isfinite(error) or error < 0:
            raise SparseAuditError("COLMAP points3D.txt 包含无效重投影误差。")
        track_length = len(track_values) // 2
        point_count += 1
        observations += track_length
        error_sum += error
    return _point_statistics(point_count, observations, error_sum)


def _point_statistics(
    point_count: int, observations: int, error_sum: float
) -> _PointStatistics:
    return _PointStatistics(
        point_count=point_count,
        observation_count=observations,
        average_track_length=(observations / point_count if point_count else None),
        mean_reprojection_error_px=(error_sum / point_count if point_count else None),
    )


def _natural_key(value: str) -> tuple[tuple[int, object], ...]:
    return tuple(
        (1, int(part)) if part.isdigit() else (0, part.casefold())
        for part in re.split(r"(\d+)", value)
    )


def image_timeline(images: Path) -> tuple[str, ...]:
    if not images.is_dir():
        raise SparseAuditError(f"图像目录不存在：{images}")
    names = [
        path.relative_to(images).as_posix()
        for path in images.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    ]
    names.sort(key=_natural_key)
    if not names:
        raise SparseAuditError(f"图像目录中没有 JPG/PNG 帧：{images}")
    return tuple(names)


def longest_unregistered_gap(
    timeline: Iterable[str], registered_names: Iterable[str]
) -> TimelineGap:
    frames = tuple(timeline)
    registered = {
        name.replace("\\", "/").casefold() for name in registered_names
    }
    best_count = current_count = 0
    best_start = current_start = 0
    for index, name in enumerate(frames):
        if name.replace("\\", "/").casefold() in registered:
            current_count = 0
            current_start = index + 1
            continue
        if current_count == 0:
            current_start = index
        current_count += 1
        if current_count > best_count:
            best_count = current_count
            best_start = current_start
    if best_count == 0:
        return TimelineGap(0, None, None)
    return TimelineGap(
        best_count,
        frames[best_start],
        frames[best_start + best_count - 1],
    )


def find_models(sparse: Path) -> tuple[Path, ...]:
    if not sparse.is_dir():
        raise SparseAuditError(f"稀疏模型目录不存在：{sparse}")
    candidates = [sparse, *(path for path in sparse.iterdir() if path.is_dir())]
    models = []
    for candidate in candidates:
        binary = all((candidate / name).is_file() for name in (
            "cameras.bin", "images.bin", "points3D.bin"
        ))
        text = all((candidate / name).is_file() for name in (
            "cameras.txt", "images.txt", "points3D.txt"
        ))
        if binary or text:
            models.append(candidate)
    if not models:
        raise SparseAuditError(f"没有找到完整 COLMAP 稀疏模型：{sparse}")
    return tuple(sorted(set(models), key=lambda path: _natural_key(path.name)))


def audit_sparse_project(
    project: Path,
    *,
    min_registration_ratio: float = 0.85,
    max_reprojection_error_px: float = 1.5,
    min_average_track_length: float = 3.0,
) -> SparseAudit:
    """Audit every connected model and gate the largest single component."""

    if not 0 <= min_registration_ratio <= 1:
        raise SparseAuditError("最低注册比例必须在 0 到 1 之间。")
    if max_reprojection_error_px <= 0 or not math.isfinite(max_reprojection_error_px):
        raise SparseAuditError("最大重投影误差必须是正数。")
    if min_average_track_length <= 0 or not math.isfinite(min_average_track_length):
        raise SparseAuditError("最低平均轨长必须是正数。")

    project = project.resolve(strict=False)
    timeline = image_timeline(project / "images")
    total = len(timeline)
    timeline_keys = {name.replace("\\", "/").casefold() for name in timeline}
    unique_registered: set[str] = set()
    results: list[ModelAudit] = []
    for model in find_models(project / "sparse"):
        names = read_registered_image_names(model)
        normalized_names = {
            name.replace("\\", "/").casefold() for name in names
        }
        unique_registered.update(normalized_names)
        points = read_point_statistics(model)
        ratio = len(names) / total
        mean_error = points.mean_reprojection_error_px
        track_length = points.average_track_length
        results.append(ModelAudit(
            model=str(model.resolve(strict=False)),
            registered_images=len(names),
            registration_ratio=ratio,
            point_count=points.point_count,
            observation_count=points.observation_count,
            average_track_length=track_length,
            mean_reprojection_error_px=mean_error,
            max_unregistered_gap=longest_unregistered_gap(timeline, names),
            missing_source_images=len(normalized_names - timeline_keys),
            passes_registration=ratio >= min_registration_ratio,
            passes_reprojection_error=(
                mean_error is not None and mean_error <= max_reprojection_error_px
            ),
            passes_track_length=(
                track_length is not None and track_length >= min_average_track_length
            ),
        ))
    results.sort(key=lambda item: (-item.registered_images, item.model.casefold()))
    selected = results[0]
    unique_on_timeline = len(unique_registered & timeline_keys)
    return SparseAudit(
        project=str(project),
        total_frames=total,
        unique_registered_images=unique_on_timeline,
        unique_registration_ratio=unique_on_timeline / total,
        thresholds={
            "min_registration_ratio": min_registration_ratio,
            "max_reprojection_error_px": max_reprojection_error_px,
            "min_average_track_length": min_average_track_length,
        },
        models=tuple(results),
        selected_model=selected.model,
    )


def _metric(value: float | None, digits: int = 3) -> str:
    return "无数据" if value is None else f"{value:.{digits}f}"


def format_sparse_audit(report: SparseAudit) -> str:
    lines = [
        f"稀疏模型质量审计：{report.project}",
        f"总帧数：{report.total_frames}",
        (
            "所有连通模型注册帧并集："
            f"{report.unique_registered_images}/{report.total_frames} "
            f"({report.unique_registration_ratio:.1%})"
        ),
        "注意：质量门槛只评估最大的单一连通模型，不会把碎片模型相加。",
    ]
    for index, model in enumerate(report.models, 1):
        marker = " [已选择]" if model.model == report.selected_model else ""
        gap = model.max_unregistered_gap
        gap_range = (
            "无" if gap.count == 0 else f"{gap.count} 帧（{gap.start} → {gap.end}）"
        )
        lines.extend((
            "",
            f"模型 {index}{marker}：{model.model}",
            (
                f"  注册：{model.registered_images}/{report.total_frames} "
                f"({model.registration_ratio:.1%})"
            ),
            f"  稀疏点：{model.point_count}；观测：{model.observation_count}",
            f"  平均轨长：{_metric(model.average_track_length)}",
            f"  平均重投影误差：{_metric(model.mean_reprojection_error_px)} px",
            f"  注册时间线最大连续缺口：{gap_range}",
            f"  模型中缺少源文件的图像：{model.missing_source_images}",
            f"  单模型门槛：{'通过' if model.passes else '未通过'}",
        ))
    thresholds = report.thresholds
    lines.extend((
        "",
        (
            "门槛：注册比例 >= "
            f"{thresholds['min_registration_ratio']:.0%}；平均重投影误差 <= "
            f"{thresholds['max_reprojection_error_px']:.3f} px；平均轨长 >= "
            f"{thresholds['min_average_track_length']:.3f}"
        ),
        f"最终结果：{'通过' if report.passes else '未通过'}",
    ))
    return "\n".join(lines)
