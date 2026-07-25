#!/usr/bin/env python3
"""Windows-friendly room capture and Gaussian-splat preparation helper.

The module intentionally imports OpenCV only inside ``capture`` and
``import-video`` so that ``doctor``, dry-runs, and most unit tests work on
machines without a camera or OpenCV installation.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from string import Formatter
from typing import Any, Mapping, Sequence
from urllib.parse import unquote, urlsplit

from colmap_audit import SparseAuditError, audit_sparse_project, format_sparse_audit


APP_VERSION = "0.4.0"
QUALITY_GATE_EXIT_CODE = 3
MIN_PYTHON = (3, 10)
SCANNER_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCANNER_DIR.parent
DEFAULT_DATASET_ROOT = SCANNER_DIR / "datasets"
LOCAL_COLMAP_EXE = PROJECT_ROOT / ".tools" / "colmap" / "bin" / "colmap.exe"
LOCAL_BRUSH_EXE = PROJECT_ROOT / ".tools" / "brush" / "brush_app.exe"
LOCAL_OPENMVS_DIR = (
    PROJECT_ROOT / ".tools" / "openmvs" / "vc17" / "x64" / "Release"
)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}

OPENMVS_EXECUTABLES = {
    "interface_colmap": "InterfaceCOLMAP.exe",
    "densify_point_cloud": "DensifyPointCloud.exe",
    "reconstruct_mesh": "ReconstructMesh.exe",
    "texture_mesh": "TextureMesh.exe",
}
GLB_MAGIC = b"glTF"
GLB_VERSION = 2
GLB_JSON_CHUNK = 0x4E4F534A
GLB_BIN_CHUNK = 0x004E4942

WINDOWS_FORBIDDEN = set('<>:"/\\|?*')
WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

# Brush v0.3.0 is the latest published Windows release. The unreleased main
# branch renamed --total-steps to --total-train-iters. Keep both profiles and
# inspect ``--help`` at runtime instead of guessing from a zip filename.
BRUSH_V03_ARGS_TEMPLATE = [
    "{dataset}",
    "--total-steps",
    "{iterations}",
    "--max-resolution",
    "{max_resolution}",
    "--export-every",
    "{iterations}",
    "--export-path",
    "{output}",
    "--export-name",
    "{ply_name}",
]

BRUSH_MAIN_ARGS_TEMPLATE = [
    "{dataset}",
    "--total-train-iters",
    "{iterations}",
    "--max-resolution",
    "{max_resolution}",
    "--export-every",
    "{iterations}",
    "--export-path",
    "{output}",
    "--export-name",
    "{ply_name}",
]

BRUSH_PROFILES = {
    "v0.3": BRUSH_V03_ARGS_TEMPLATE,
    "main": BRUSH_MAIN_ARGS_TEMPLATE,
}

BRUSH_TEMPLATE_FIELDS = {
    "dataset",
    "output",
    "ply",
    "ply_name",
    "project",
    "iterations",
    "max_resolution",
}


class RoomScanError(RuntimeError):
    """Expected user-facing error with a Chinese message."""


class ChineseArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, f"参数错误：{message}\n")


@dataclass(frozen=True)
class DatasetPaths:
    root: Path
    project: Path
    images: Path
    sparse: Path
    brush_output: Path


@dataclass(frozen=True)
class CpuReconstructionPaths:
    output: Path
    colmap: Path
    scene: Path
    dense_scene: Path
    dense_cloud: Path
    mesh: Path
    textured_glb: Path
    embedded_glb: Path


@dataclass(frozen=True)
class OpenMvsTools:
    interface_colmap: str | None
    densify_point_cloud: str | None
    reconstruct_mesh: str | None
    texture_mesh: str | None
    detail: str

    @property
    def ok(self) -> bool:
        return all(
            (
                self.interface_colmap,
                self.densify_point_cloud,
                self.reconstruct_mesh,
                self.texture_mesh,
            )
        )


@dataclass(frozen=True)
class CpuReconstructionPreset:
    max_resolution: int
    min_resolution: int
    thread_cap: int | None
    densify_resolution_level: int
    densify_sub_resolution_levels: int
    densify_number_views: int
    densify_number_views_fuse: int
    densify_iters: int
    densify_geometric_iters: int
    densify_fusion_filter: int
    mesh_remove_spurious: int
    mesh_close_holes: int
    mesh_smooth: int
    mesh_decimate: float
    texture_resolution_level: int
    texture_max_size: int


# ``standard`` deliberately mirrors the original cpu-reconstruct command so
# existing invocations remain byte-for-byte compatible. ``high`` follows the
# OpenMVS 2.4 defaults/option semantics while capping 4K inputs and concurrency
# to keep peak memory practical on the target 32 GB Windows laptop.
CPU_RECONSTRUCTION_PRESETS = {
    "standard": CpuReconstructionPreset(
        max_resolution=1280,
        min_resolution=320,
        thread_cap=None,
        densify_resolution_level=1,
        densify_sub_resolution_levels=1,
        densify_number_views=4,
        densify_number_views_fuse=2,
        densify_iters=3,
        densify_geometric_iters=1,
        densify_fusion_filter=1,
        mesh_remove_spurious=4,
        mesh_close_holes=30,
        mesh_smooth=2,
        mesh_decimate=0.5,
        texture_resolution_level=1,
        texture_max_size=4096,
    ),
    "high": CpuReconstructionPreset(
        max_resolution=1920,
        min_resolution=640,
        thread_cap=8,
        densify_resolution_level=0,
        densify_sub_resolution_levels=2,
        densify_number_views=5,
        densify_number_views_fuse=2,
        densify_iters=3,
        densify_geometric_iters=2,
        densify_fusion_filter=2,
        mesh_remove_spurious=4,
        mesh_close_holes=15,
        mesh_smooth=1,
        mesh_decimate=1.0,
        texture_resolution_level=0,
        texture_max_size=8192,
    ),
}


@dataclass(frozen=True)
class ToolResult:
    name: str
    executable: str | None
    detail: str

    @property
    def ok(self) -> bool:
        return self.executable is not None


@dataclass(frozen=True)
class SparseQualityReport:
    """Best connected COLMAP model coverage over all imported images."""

    total_images: int
    models: tuple[tuple[Path, int], ...]
    best_model: Path
    best_registered: int
    threshold_percent: float

    @property
    def coverage_percent(self) -> float:
        return self.best_registered * 100.0 / self.total_images

    @property
    def passed(self) -> bool:
        return self.coverage_percent >= self.threshold_percent


def _path_text(path: Path) -> str:
    return str(path.resolve(strict=False))


def validate_component(value: str, label: str = "名称") -> str:
    """Validate one cross-platform-safe path component."""

    if not value or value in {".", ".."}:
        raise RoomScanError(f"{label}不能为空，也不能是 . 或 ..。")
    if len(value) > 80:
        raise RoomScanError(f"{label}过长，请限制在 80 个字符以内。")
    if value != value.rstrip(" ."):
        raise RoomScanError(f"{label}不能以空格或句点结尾。")
    if any(ord(char) < 32 or char in WINDOWS_FORBIDDEN for char in value):
        raise RoomScanError(
            f"{label}包含 Windows 不允许的字符；请不要使用 < > : \" / \\ | ? *。"
        )
    if Path(value).name != value or Path(value).is_absolute():
        raise RoomScanError(f"{label}必须是单个目录或文件名，不能包含路径。")
    stem = value.split(".", 1)[0].upper()
    if stem in WINDOWS_RESERVED:
        raise RoomScanError(f"{label}不能使用 Windows 保留名称 {stem}。")
    return value


def ensure_within(path: Path, root: Path, label: str) -> Path:
    resolved_root = root.expanduser().resolve(strict=False)
    resolved_path = path.expanduser().resolve(strict=False)
    try:
        resolved_path.relative_to(resolved_root)
    except ValueError as error:
        raise RoomScanError(f"{label}必须位于数据集目录内：{resolved_root}") from error
    return resolved_path


def dataset_paths(dataset_root: str | os.PathLike[str], project: str) -> DatasetPaths:
    project_name = validate_component(project, "项目名")
    root = Path(dataset_root).expanduser().resolve(strict=False)
    project_path = ensure_within(root / project_name, root, "项目路径")
    return DatasetPaths(
        root=root,
        project=project_path,
        images=ensure_within(project_path / "images", project_path, "图像目录"),
        sparse=ensure_within(project_path / "sparse", project_path, "稀疏模型目录"),
        brush_output=ensure_within(
            project_path / "brush", project_path, "Brush 输出目录"
        ),
    )


def cpu_reconstruction_paths(paths: DatasetPaths, project: str) -> CpuReconstructionPaths:
    """Return every CPU/OpenMVS output under the selected project directory."""

    project_name = validate_component(project, "项目名")
    output = ensure_within(paths.project / "openmvs", paths.project, "OpenMVS 输出目录")
    textured_name = f"{project_name}-textured.glb"
    embedded_name = f"{project_name}-textured-embedded.glb"
    return CpuReconstructionPaths(
        output=output,
        colmap=ensure_within(output / "colmap", paths.project, "去畸变输出目录"),
        scene=ensure_within(output / "scene_cpu.mvs", paths.project, "OpenMVS 场景"),
        dense_scene=ensure_within(
            output / "scene_cpu_dense.mvs", paths.project, "稠密场景"
        ),
        dense_cloud=ensure_within(
            output / "scene_cpu_dense.ply", paths.project, "稠密点云"
        ),
        mesh=ensure_within(output / "scene_cpu_mesh.ply", paths.project, "网格"),
        textured_glb=ensure_within(
            output / textured_name, paths.project, "纹理 GLB"
        ),
        embedded_glb=ensure_within(
            output / embedded_name, paths.project, "内嵌纹理 GLB"
        ),
    )


def validate_ply_name(value: str) -> str:
    name = validate_component(value, "PLY 文件名")
    if Path(name).suffix.lower() != ".ply":
        raise RoomScanError("PLY 文件名必须以 .ply 结尾。")
    return name


def image_files(images_dir: Path) -> list[Path]:
    if not images_dir.is_dir():
        return []
    return sorted(
        path
        for path in images_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )


def next_frame_index(images_dir: Path) -> int:
    highest = 0
    pattern = re.compile(r"^frame_(\d{6,})\.(?:jpg|jpeg|png)$", re.IGNORECASE)
    for path in image_files(images_dir):
        match = pattern.match(path.name)
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def save_capture_frame(
    cv2_module: Any,
    frame: Any,
    images_dir: Path,
    frame_index: int,
    jpeg_quality: int,
) -> tuple[Path, int]:
    while True:
        target = images_dir / f"frame_{frame_index:06d}.jpg"
        frame_index += 1
        if not target.exists():
            break
    write_ok = cv2_module.imwrite(
        str(target),
        frame,
        [int(cv2_module.IMWRITE_JPEG_QUALITY), jpeg_quality],
    )
    if not write_ok:
        raise RoomScanError(f"OpenCV 无法写入图像：{target}")
    return target, frame_index


def _replace_with_retry(source: Path, target: Path, attempts: int = 8) -> None:
    """Atomically publish a file, tolerating short Windows scanner locks."""

    for attempt in range(attempts):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt + 1 >= attempts:
                raise
            time.sleep(min(0.05 * (2**attempt), 0.5))


def atomic_write_video_frame(
    cv2_module: Any,
    frame: Any,
    target: Path,
    jpeg_quality: int,
) -> None:
    """Encode one JPEG beside ``target`` and publish it without overwriting.

    The exclusive zero-byte reservation prevents this process from replacing a
    pre-existing frame.  ``os.replace`` then publishes the fully encoded and
    flushed temporary JPEG atomically on the same filesystem.
    """

    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise RoomScanError(f"目标帧已存在，拒绝覆盖：{target}")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.stem}.", suffix=".tmp.jpg", dir=str(target.parent)
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    reserved = False
    published = False
    try:
        write_ok = cv2_module.imwrite(
            str(temporary),
            frame,
            [int(cv2_module.IMWRITE_JPEG_QUALITY), jpeg_quality],
        )
        if not write_ok:
            raise RoomScanError(f"OpenCV 无法编码视频帧：{target.name}")
        # Windows' _commit (used by os.fsync) requires a writable descriptor.
        with temporary.open("r+b") as handle:
            os.fsync(handle.fileno())

        try:
            target_descriptor = os.open(
                target,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError as error:
            raise RoomScanError(f"目标帧已存在，拒绝覆盖：{target}") from error
        else:
            os.close(target_descriptor)
            reserved = True

        _replace_with_retry(temporary, target)
        published = True
    except OSError as error:
        raise RoomScanError(f"无法原子写入视频帧 {target.name}：{error}") from error
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass
        if reserved and not published and target.exists():
            try:
                target.unlink()
            except OSError:
                pass


def _resize_video_frame(cv2_module: Any, frame: Any, max_width: int) -> Any:
    shape = getattr(frame, "shape", ())
    if len(shape) < 2:
        raise RoomScanError("OpenCV 返回了没有有效尺寸的视频帧。")
    height, width = int(shape[0]), int(shape[1])
    if width <= 0 or height <= 0:
        raise RoomScanError("OpenCV 返回了尺寸为零的视频帧。")
    if max_width == 0 or width <= max_width:
        return frame
    output_height = max(1, round(height * max_width / width))
    return cv2_module.resize(
        frame,
        (max_width, output_height),
        interpolation=cv2_module.INTER_AREA,
    )


def _video_motion_thumbnail(cv2_module: Any, gray: Any) -> Any:
    return cv2_module.resize(
        gray,
        (256, 144),
        interpolation=cv2_module.INTER_AREA,
    )


def _video_motion_difference(cv2_module: Any, current: Any, previous: Any) -> float:
    difference = cv2_module.absdiff(current, previous)
    channels = cv2_module.mean(difference)
    return float(channels[0])


def _remove_imported_frames(created: Sequence[Path]) -> None:
    for path in reversed(created):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            print(f"警告：失败清理时无法删除本次新帧：{path}", file=sys.stderr)


def next_video_manifest_path(project_dir: Path) -> Path:
    first = project_dir / "video-import-manifest.json"
    if not first.exists():
        return first
    index = 2
    while True:
        candidate = project_dir / f"video-import-manifest-{index:03d}.json"
        if not candidate.exists():
            return candidate
        index += 1


def atomic_write_json(target: Path, document: Mapping[str, Any]) -> None:
    """Write UTF-8 JSON atomically while refusing to replace an old manifest."""

    target.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.stem}.", suffix=".tmp.json", dir=str(target.parent)
    )
    temporary = Path(temporary_name)
    reserved = False
    published = False
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            target_descriptor = os.open(
                target,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError as error:
            raise RoomScanError(f"视频导入清单已存在，拒绝覆盖：{target}") from error
        else:
            os.close(target_descriptor)
            reserved = True
        _replace_with_retry(temporary, target)
        published = True
    except OSError as error:
        raise RoomScanError(f"无法原子写入视频导入清单：{error}") from error
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass
        if reserved and not published and target.exists():
            try:
                target.unlink()
            except OSError:
                pass


def _looks_like_path(value: str) -> bool:
    return (
        Path(value).is_absolute()
        or any(separator in value for separator in (os.sep, os.altsep) if separator)
        or value.lower().endswith((".exe", ".bat", ".cmd"))
    )


def _colmap_exe_from_launcher(path: Path) -> Path | None:
    if path.suffix.lower() not in {".bat", ".cmd"}:
        return path
    candidates = [
        path.with_suffix(".exe"),
        path.parent / "colmap.exe",
        path.parent / "bin" / "colmap.exe",
    ]
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def locate_tool(
    name: str,
    explicit: str | None,
    env_names: Sequence[str],
    command_names: Sequence[str],
) -> ToolResult:
    requested = explicit
    source = "命令行参数"
    if not requested:
        for env_name in env_names:
            if os.environ.get(env_name):
                requested = os.environ[env_name]
                source = f"环境变量 {env_name}"
                break

    found: str | None = None
    if requested:
        expanded = str(Path(requested).expanduser()) if _looks_like_path(requested) else requested
        if Path(expanded).is_file():
            found = str(Path(expanded).resolve())
        else:
            found = shutil.which(expanded)
        if not found:
            return ToolResult(name, None, f"{source}指向的程序不存在：{requested}")
    else:
        for candidate in command_names:
            found = shutil.which(candidate)
            if found:
                break

    if not found:
        return ToolResult(name, None, "未在 PATH 中找到，也没有配置工具路径")

    path = Path(found).resolve()
    if name == "COLMAP" and path.suffix.lower() in {".bat", ".cmd"}:
        direct_exe = _colmap_exe_from_launcher(path)
        if direct_exe is None:
            return ToolResult(
                name,
                None,
                "找到了 COLMAP.bat，但为保证 shell=False，"
                "请把 --colmap 或 COLMAP_EXE 指向其 bin\\colmap.exe。",
            )
        path = direct_exe.resolve()

    return ToolResult(name, str(path), f"已找到：{path}")


def locate_colmap(explicit: str | None = None) -> ToolResult:
    return locate_tool(
        "COLMAP",
        explicit,
        ("COLMAP_EXE", "COLMAP_PATH"),
        (_path_text(LOCAL_COLMAP_EXE), "colmap.exe", "colmap", "COLMAP.bat"),
    )


def locate_brush(explicit: str | None = None) -> ToolResult:
    return locate_tool(
        "Brush",
        explicit,
        ("BRUSH_EXE", "BRUSH_PATH"),
        (
            _path_text(LOCAL_BRUSH_EXE),
            "brush.exe",
            "brush-cli.exe",
            "brush",
            "brush-cli",
            "brush_app.exe",
            "brush-app.exe",
        ),
    )


def _openmvs_tools_from_directory(directory: Path) -> OpenMvsTools:
    resolved = directory.expanduser().resolve(strict=False)
    values: dict[str, str | None] = {}
    missing: list[str] = []
    for field, filename in OPENMVS_EXECUTABLES.items():
        executable = resolved / filename
        if executable.is_file():
            values[field] = str(executable.resolve())
        else:
            values[field] = None
            missing.append(filename)
    if missing:
        detail = f"目录 {resolved} 缺少：{', '.join(missing)}"
    else:
        detail = f"已找到 4 个 CPU 重建程序：{resolved}"
    return OpenMvsTools(detail=detail, **values)


def locate_openmvs(explicit: str | None = None) -> OpenMvsTools:
    """Locate the four OpenMVS executables as one version-compatible suite."""

    requested = explicit
    source = "命令行参数 --openmvs"
    if not requested:
        for env_name in ("OPENMVS_DIR", "OPENMVS_PATH"):
            if os.environ.get(env_name):
                requested = os.environ[env_name]
                source = f"环境变量 {env_name}"
                break

    if requested:
        candidate = Path(requested).expanduser()
        if candidate.is_file():
            candidate = candidate.parent
        if not candidate.is_dir():
            return OpenMvsTools(
                None,
                None,
                None,
                None,
                f"{source}指向的目录或程序不存在：{requested}",
            )
        return _openmvs_tools_from_directory(candidate)

    local = _openmvs_tools_from_directory(LOCAL_OPENMVS_DIR)
    if local.ok:
        return local

    located: dict[str, str | None] = {}
    missing: list[str] = []
    for field, filename in OPENMVS_EXECUTABLES.items():
        executable = shutil.which(filename) or shutil.which(Path(filename).stem)
        located[field] = str(Path(executable).resolve()) if executable else None
        if not executable:
            missing.append(filename)
    detail = (
        "已从 PATH 找到 4 个 CPU 重建程序"
        if not missing
        else "未在项目工具目录或 PATH 中找到：" + ", ".join(missing)
    )
    return OpenMvsTools(detail=detail, **located)


def require_openmvs(result: OpenMvsTools) -> OpenMvsTools:
    if result.ok:
        return result
    raise RoomScanError(
        f"未找到完整 OpenMVS 工具组。{result.detail}。"
        "请使用 --openmvs 指定 Release 目录，或设置环境变量 OPENMVS_DIR。"
    )


def openmvs_tools_for_dry_run(explicit: str | None = None) -> OpenMvsTools:
    located = locate_openmvs(explicit)
    if located.ok:
        return located
    base = Path(explicit).expanduser() if explicit else LOCAL_OPENMVS_DIR
    if base.suffix.lower() == ".exe":
        base = base.parent
    base = base.resolve(strict=False)
    values = {
        field: str(base / filename)
        for field, filename in OPENMVS_EXECUTABLES.items()
    }
    return OpenMvsTools(detail="dry-run 占位路径", **values)


def openmvs_runtime_environment(tools: OpenMvsTools) -> dict[str, str]:
    env = dict(os.environ)
    first = tools.interface_colmap
    if first:
        executable_dir = str(Path(first).resolve(strict=False).parent)
        current_path = env.get("PATH", "")
        env["PATH"] = os.pathsep.join(
            [executable_dir, *([current_path] if current_path else [])]
        )
    return env


def require_tool(result: ToolResult, option: str, env_name: str) -> str:
    if result.executable:
        return result.executable
    raise RoomScanError(
        f"未找到 {result.name}。{result.detail}。"
        f"请使用 {option} 指定 .exe，或设置环境变量 {env_name}。"
    )


def colmap_runtime_environment(executable: str) -> dict[str, str]:
    """Set the DLL and Qt paths normally prepared by official COLMAP.bat.

    The child still starts as an argument list with ``shell=False``.
    """

    env = dict(os.environ)
    executable_path = Path(executable).resolve(strict=False)
    install_root = (
        executable_path.parent.parent
        if executable_path.parent.name.lower() == "bin"
        else executable_path.parent
    )
    path_entries = [executable_path.parent]
    library_dir = install_root / "lib"
    if library_dir.is_dir():
        path_entries.insert(0, library_dir)
        plugin_dir = library_dir / "plugins"
        if plugin_dir.is_dir():
            env["QT_PLUGIN_PATH"] = str(plugin_dir)
    current_path = env.get("PATH", "")
    env["PATH"] = os.pathsep.join(
        [*(str(path) for path in path_entries), *([current_path] if current_path else [])]
    )
    return env


def probe_version(executable: str, env: Mapping[str, str] | None = None) -> str:
    try:
        completed = subprocess.run(
            [executable, "--version"],
            check=False,
            shell=False,
            capture_output=True,
            text=True,
            timeout=8,
            env=dict(env) if env is not None else None,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "程序存在，但版本探测未完成"
    text = (completed.stdout or completed.stderr or "").strip().splitlines()
    return text[0].strip() if text else "程序存在（未返回版本文本）"


def display_command(command: Sequence[str]) -> str:
    return subprocess.list2cmdline([str(part) for part in command])


def validate_command(command: Sequence[str]) -> list[str]:
    if not command:
        raise RoomScanError("内部错误：外部命令为空。")
    normalized: list[str] = []
    for part in command:
        value = str(part)
        if not value or "\x00" in value:
            raise RoomScanError("外部命令包含空参数或 NUL 字符，已拒绝执行。")
        normalized.append(value)
    return normalized


def run_external(
    command: Sequence[str],
    cwd: Path,
    dry_run: bool,
    env: Mapping[str, str] | None = None,
) -> None:
    normalized = validate_command(command)
    print(f"将执行：\n  {display_command(normalized)}")
    print(f"工作目录：{cwd}")
    if dry_run:
        print("[dry-run] 仅显示命令，没有创建目录，也没有启动外部程序。")
        return
    try:
        subprocess.run(
            normalized,
            cwd=str(cwd),
            check=True,
            shell=False,
            env=dict(env) if env is not None else None,
        )
    except FileNotFoundError as error:
        raise RoomScanError(f"无法启动外部程序：{normalized[0]}") from error
    except subprocess.CalledProcessError as error:
        raise RoomScanError(
            f"外部程序执行失败，退出码 {error.returncode}。请查看上方日志。"
        ) from error
    except OSError as error:
        raise RoomScanError(f"启动外部程序失败：{error}") from error


def build_colmap_command(
    executable: str,
    paths: DatasetPaths,
    quality: str = "MEDIUM",
    camera_model: str = "SIMPLE_RADIAL",
) -> list[str]:
    return [
        executable,
        "automatic_reconstructor",
        "--workspace_path",
        _path_text(paths.project),
        "--image_path",
        _path_text(paths.images),
        "--data_type",
        "VIDEO",
        "--quality",
        quality.upper(),
        "--camera_model",
        camera_model,
        "--single_camera",
        "1",
        "--sparse",
        "1",
        "--dense",
        "0",
        "--use_gpu",
        "0",
    ]


def build_colmap_video_commands(
    executable: str,
    paths: DatasetPaths,
    max_image_size: int = 3200,
    max_num_features: int = 8192,
    affine_shape: bool = False,
    domain_size_pooling: bool = False,
    overlap: int = 20,
    quadratic_overlap: bool = True,
    max_threads: int | None = None,
    loop_detection: bool = False,
    vocab_tree_path: str | os.PathLike[str] | None = None,
) -> list[list[str]]:
    """Build the explicit high-quality COLMAP 4.1 sparse video pipeline.

    The option names are intentionally kept in the COLMAP 4.1 namespaces
    reported by each subcommand's ``-h`` output. Loop detection remains opt-in
    and requires an explicit local vocabulary tree path.
    """

    if max_threads is not None and max_threads <= 0:
        raise RoomScanError("COLMAP 最大线程数必须是正数。")
    if loop_detection and vocab_tree_path is None:
        raise RoomScanError("启用回环检测时必须提供 vocabulary tree 路径。")
    if not loop_detection and vocab_tree_path is not None:
        raise RoomScanError("只有启用回环检测时才能提供 vocabulary tree 路径。")

    database = paths.project / "database.db"

    def boolean(enabled: bool) -> str:
        return "1" if enabled else "0"

    feature_command = [
        executable,
        "feature_extractor",
        "--database_path",
        _path_text(database),
        "--image_path",
        _path_text(paths.images),
        "--ImageReader.camera_model",
        "SIMPLE_RADIAL",
        "--ImageReader.single_camera",
        "1",
        "--FeatureExtraction.type",
        "SIFT",
        "--FeatureExtraction.use_gpu",
        "0",
        "--FeatureExtraction.max_image_size",
        str(max_image_size),
        "--SiftExtraction.max_num_features",
        str(max_num_features),
        "--SiftExtraction.estimate_affine_shape",
        boolean(affine_shape),
        "--SiftExtraction.domain_size_pooling",
        boolean(domain_size_pooling),
    ]
    matching_command = [
        executable,
        "sequential_matcher",
        "--database_path",
        _path_text(database),
        "--FeatureMatching.type",
        "SIFT_BRUTEFORCE",
        "--FeatureMatching.use_gpu",
        "0",
        "--FeatureMatching.guided_matching",
        "1",
        "--FeatureMatching.max_num_matches",
        "32768",
        "--SiftMatching.cpu_brute_force_matcher",
        "1",
        "--SequentialMatching.overlap",
        str(overlap),
        "--SequentialMatching.quadratic_overlap",
        boolean(quadratic_overlap),
        "--SequentialMatching.loop_detection",
        boolean(loop_detection),
    ]
    mapper_command = [
        executable,
        "mapper",
        "--database_path",
        _path_text(database),
        "--image_path",
        _path_text(paths.images),
        "--output_path",
        _path_text(paths.sparse),
        "--Mapper.multiple_models",
        "1",
        "--Mapper.init_num_trials",
        "400",
        "--Mapper.max_reg_trials",
        "5",
        "--Mapper.ba_use_gpu",
        "0",
        "--Mapper.ba_local_max_num_iterations",
        "50",
        "--Mapper.ba_global_max_num_iterations",
        "100",
    ]

    if max_threads is not None:
        thread_count = str(max_threads)
        feature_command.extend(["--FeatureExtraction.num_threads", thread_count])
        matching_command.extend(
            [
                "--FeatureMatching.num_threads",
                thread_count,
                "--SequentialMatching.num_threads",
                thread_count,
            ]
        )
        mapper_command.extend(["--Mapper.num_threads", thread_count])
    if loop_detection:
        matching_command.extend(
            [
                "--SequentialMatching.vocab_tree_path",
                _path_text(Path(vocab_tree_path)),
            ]
        )

    return [feature_command, matching_command, mapper_command]


def find_colmap_models(sparse_dir: Path) -> list[Path]:
    if not sparse_dir.is_dir():
        return []
    models: list[Path] = []
    for directory in [sparse_dir, *(path for path in sparse_dir.iterdir() if path.is_dir())]:
        has_binary = all((directory / name).is_file() for name in (
            "cameras.bin",
            "images.bin",
            "points3D.bin",
        ))
        has_text = all((directory / name).is_file() for name in (
            "cameras.txt",
            "images.txt",
            "points3D.txt",
        ))
        if has_binary or has_text:
            models.append(directory)
    return sorted(set(models))


def colmap_model_image_count(model: Path) -> int:
    """Read COLMAP's registered-image count without loading the full model."""

    binary = model / "images.bin"
    if binary.is_file():
        try:
            with binary.open("rb") as handle:
                header = handle.read(8)
        except OSError as error:
            raise RoomScanError(f"无法读取 COLMAP 模型：{binary}：{error}") from error
        if len(header) != 8:
            raise RoomScanError(f"COLMAP images.bin 头部不完整：{binary}")
        return int(struct.unpack("<Q", header)[0])

    text_model = model / "images.txt"
    if not text_model.is_file():
        raise RoomScanError(f"COLMAP 模型缺少 images.bin/images.txt：{model}")
    try:
        lines = text_model.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise RoomScanError(f"无法读取 COLMAP 模型：{text_model}：{error}") from error
    count = 0
    expecting_points = False
    for raw_line in lines:
        if raw_line.startswith("#"):
            continue
        if expecting_points:
            expecting_points = False
            continue
        if not raw_line.strip():
            continue
        count += 1
        expecting_points = True
    return count


def choose_colmap_model(
    sparse_dir: Path, model_index: int | None = None
) -> tuple[Path, list[tuple[Path, int]]]:
    models = find_colmap_models(sparse_dir)
    if not models:
        raise RoomScanError(f"未找到有效 COLMAP 稀疏模型：{sparse_dir}。请先运行 prepare。")
    ranked = sorted(
        ((model, colmap_model_image_count(model)) for model in models),
        key=lambda item: (-item[1], str(item[0]).lower()),
    )
    if model_index is None:
        return ranked[0][0], ranked
    if model_index < 0:
        raise RoomScanError("COLMAP 模型编号必须是非负整数。")
    requested = (sparse_dir / str(model_index)).resolve(strict=False)
    for model, _ in ranked:
        if model.resolve(strict=False) == requested:
            return model, ranked
    raise RoomScanError(
        f"未找到 sparse\\{model_index}；可用模型："
        + "、".join(model.name for model, _ in ranked)
    )


def analyze_sparse_quality(
    sparse_dir: Path,
    total_images: int,
    threshold_percent: float = 85.0,
) -> SparseQualityReport:
    """Measure whether one connected model registers enough source images."""

    if total_images <= 0:
        raise RoomScanError("质量统计需要至少 1 张源图像。")
    if not 0 <= threshold_percent <= 100:
        raise RoomScanError("注册率质量门槛必须在 0 到 100 之间。")
    models = find_colmap_models(sparse_dir)
    if not models:
        raise RoomScanError(
            "COLMAP 命令已结束，但没有检测到 cameras/images/points3D 模型文件。"
            "这不视为成功；请检查上方日志、图像重叠率和画面清晰度。"
        )
    ranked = tuple(
        sorted(
            ((model, colmap_model_image_count(model)) for model in models),
            key=lambda item: (-item[1], str(item[0]).lower()),
        )
    )
    best_model, best_registered = ranked[0]
    if best_registered > total_images:
        raise RoomScanError(
            f"模型注册图像数 {best_registered} 超过当前 images 中的 "
            f"{total_images} 张；请检查是否混用了旧 database/sparse 输出。"
        )
    return SparseQualityReport(
        total_images=total_images,
        models=ranked,
        best_model=best_model,
        best_registered=best_registered,
        threshold_percent=threshold_percent,
    )


def print_sparse_quality_report(report: SparseQualityReport) -> None:
    print(f"COLMAP 稀疏重建完成，共检测到 {len(report.models)} 个连通模型：")
    for model, registered in report.models:
        coverage = registered * 100.0 / report.total_images
        marker = "  ← 最佳连通模型" if model == report.best_model else ""
        print(
            f"  - {model.name or model}：{registered}/{report.total_images} 张 "
            f"({coverage:.1f}%){marker}"
        )
    comparison = "达到" if report.passed else "未达到"
    print(
        f"最佳模型注册率 {report.coverage_percent:.1f}%，{comparison} "
        f"{report.threshold_percent:.1f}% 质量门槛。"
    )


def build_cpu_reconstruction_commands(
    colmap_executable: str,
    openmvs: OpenMvsTools,
    paths: DatasetPaths,
    cpu_paths: CpuReconstructionPaths,
    sparse_model: Path,
    max_resolution: int | None = None,
    min_resolution: int | None = None,
    max_threads: int = 1,
    preset: str = "standard",
) -> list[list[str]]:
    if not openmvs.ok:
        raise RoomScanError("内部错误：OpenMVS 工具组不完整。")
    profile = CPU_RECONSTRUCTION_PRESETS.get(preset)
    if profile is None:
        raise RoomScanError(f"未知 CPU 重建预设：{preset}")
    if max_resolution is None:
        max_resolution = profile.max_resolution
    if min_resolution is None:
        min_resolution = profile.min_resolution
    return [
        [
            colmap_executable,
            "image_undistorter",
            "--image_path",
            _path_text(paths.images),
            "--input_path",
            _path_text(sparse_model),
            "--output_path",
            _path_text(cpu_paths.colmap),
            "--output_type",
            "COLMAP",
            "--max_image_size",
            str(max_resolution),
        ],
        [
            openmvs.interface_colmap or "InterfaceCOLMAP.exe",
            "-i",
            "colmap",
            "-o",
            cpu_paths.scene.name,
            "--image-folder",
            "images",
            "--binary",
            "1",
            "--max-threads",
            str(max_threads),
            "-v",
            "3",
        ],
        [
            openmvs.densify_point_cloud or "DensifyPointCloud.exe",
            "-i",
            cpu_paths.scene.name,
            "-o",
            cpu_paths.dense_scene.name,
            "--resolution-level",
            str(profile.densify_resolution_level),
            "--max-resolution",
            str(max_resolution),
            "--min-resolution",
            str(min_resolution),
            "--sub-resolution-levels",
            str(profile.densify_sub_resolution_levels),
            "--number-views",
            str(profile.densify_number_views),
            "--number-views-fuse",
            str(profile.densify_number_views_fuse),
            "--iters",
            str(profile.densify_iters),
            "--geometric-iters",
            str(profile.densify_geometric_iters),
            "--fusion-filter",
            str(profile.densify_fusion_filter),
            "--tower-mode",
            "0",
            "--estimate-roi",
            "0",
            "--crop-to-roi",
            "0",
            "--max-threads",
            str(max_threads),
            "-v",
            "3",
        ],
        [
            openmvs.reconstruct_mesh or "ReconstructMesh.exe",
            "-i",
            cpu_paths.dense_scene.name,
            "-o",
            cpu_paths.mesh.name,
            "--remove-spurious",
            str(profile.mesh_remove_spurious),
            "--close-holes",
            str(profile.mesh_close_holes),
            "--smooth",
            str(profile.mesh_smooth),
            "--decimate",
            str(profile.mesh_decimate),
            "--crop-to-roi",
            "0",
            "--max-threads",
            str(max_threads),
            "-v",
            "3",
        ],
        [
            openmvs.texture_mesh or "TextureMesh.exe",
            "-i",
            cpu_paths.dense_scene.name,
            "-m",
            cpu_paths.mesh.name,
            "-o",
            cpu_paths.textured_glb.name,
            "--export-type",
            "glb",
            "--resolution-level",
            str(profile.texture_resolution_level),
            "--min-resolution",
            str(min_resolution),
            "--max-texture-size",
            str(profile.texture_max_size),
            "--close-holes",
            "0",
            "--max-threads",
            str(max_threads),
            "-v",
            "3",
        ],
    ]


def is_nonempty_file(path: Path) -> bool:
    """Return whether ``path`` is a readable, non-empty regular file."""

    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def validate_nonempty_file(path: Path, label: str) -> None:
    try:
        if not is_nonempty_file(path):
            raise RoomScanError(f"{label}不存在或为空：{path}")
    except OSError as error:
        raise RoomScanError(f"无法检查{label}：{path}：{error}") from error


def read_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    """Read and strictly validate a GLB v2 JSON/BIN container."""

    validate_nonempty_file(path, "GLB 文件")
    try:
        data = path.read_bytes()
    except OSError as error:
        raise RoomScanError(f"无法读取 GLB：{path}：{error}") from error
    if len(data) < 20:
        raise RoomScanError(f"GLB 文件过短：{path}")
    magic, version, declared_length = struct.unpack_from("<4sII", data, 0)
    if magic != GLB_MAGIC:
        raise RoomScanError(f"GLB magic 无效：{path}")
    if version != GLB_VERSION:
        raise RoomScanError(f"只支持 GLB v2，检测到 v{version}：{path}")
    if declared_length != len(data):
        raise RoomScanError(
            f"GLB 声明长度 {declared_length} 与实际长度 {len(data)} 不一致：{path}"
        )

    chunks: list[tuple[int, bytes]] = []
    offset = 12
    while offset < len(data):
        if offset + 8 > len(data):
            raise RoomScanError(f"GLB chunk 头部不完整：{path}")
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        end = offset + chunk_length
        if end > len(data):
            raise RoomScanError(f"GLB chunk 长度越界：{path}")
        chunks.append((chunk_type, data[offset:end]))
        offset = end
    if offset != len(data) or not chunks or chunks[0][0] != GLB_JSON_CHUNK:
        raise RoomScanError(f"GLB 缺少首个 JSON chunk：{path}")
    if len(chunks) > 2 or (
        len(chunks) == 2 and chunks[1][0] != GLB_BIN_CHUNK
    ):
        raise RoomScanError(f"GLB 包含不支持的 chunk 布局：{path}")
    try:
        document = json.loads(chunks[0][1].decode("utf-8").rstrip(" \t\r\n\x00"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RoomScanError(f"GLB JSON 无法解析：{path}：{error}") from error
    if not isinstance(document, dict):
        raise RoomScanError(f"GLB JSON 根节点必须是对象：{path}")
    binary = chunks[1][1] if len(chunks) == 2 else b""
    buffers = document.get("buffers", [])
    if buffers:
        if not isinstance(buffers, list):
            raise RoomScanError(f"GLB buffers 必须是数组：{path}")
        for index, buffer in enumerate(buffers):
            if not isinstance(buffer, dict):
                raise RoomScanError(f"GLB buffers[{index}] 必须是 buffer 对象：{path}")
            declared_length = buffer.get("byteLength")
            if not isinstance(declared_length, int) or declared_length < 0:
                raise RoomScanError(
                    f"GLB buffers[{index}].byteLength 无效：{path}"
                )
            uri = buffer.get("uri")
            if uri is not None and not isinstance(uri, str):
                raise RoomScanError(f"GLB buffers[{index}].uri 必须是字符串：{path}")
            if index == 0 and uri is None:
                if declared_length > len(binary):
                    raise RoomScanError(
                        f"GLB BIN chunk 短于 buffers[0].byteLength：{path}"
                    )
            elif index > 0 and uri is None:
                raise RoomScanError(
                    f"GLB buffers[{index}] 缺少 URI，无法对应唯一 BIN chunk：{path}"
                )
    return document, binary


def _resolve_glb_image_uri(source: Path, uri: str, allowed_root: Path) -> Path:
    if not uri or "\x00" in uri or "\\" in uri:
        raise RoomScanError(f"GLB 纹理 URI 无效：{uri!r}")
    parsed = urlsplit(uri)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise RoomScanError(f"GLB 纹理只允许本地相对路径：{uri}")
    decoded = unquote(parsed.path)
    pure = PurePosixPath(decoded)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise RoomScanError(f"GLB 纹理路径存在越界风险：{uri}")
    candidate = ensure_within(
        source.parent.joinpath(*pure.parts), allowed_root, "GLB 纹理路径"
    )
    if not candidate.is_file():
        raise RoomScanError(f"GLB 引用的纹理不存在：{candidate}")
    return candidate


def _image_mime_type(path: Path, data: bytes) -> str:
    suffix = path.suffix.lower()
    if suffix == ".png" and data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if suffix in {".jpg", ".jpeg"} and data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    raise RoomScanError(f"仅支持有效的 PNG/JPEG GLB 纹理：{path}")


def embed_glb_images(
    source: Path,
    destination: Path,
    allowed_root: Path,
    allow_existing: bool = False,
) -> int:
    """Embed TextureMesh's external PNG/JPEG URIs into a standalone GLB."""

    root = allowed_root.resolve(strict=False)
    source_path = ensure_within(source, root, "源 GLB")
    destination_path = ensure_within(destination, root, "内嵌 GLB")
    if source_path == destination_path:
        raise RoomScanError("源 GLB 与内嵌 GLB 不能使用同一路径。")
    if destination_path.exists() and not allow_existing:
        raise RoomScanError(f"目标 GLB 已存在，已拒绝覆盖：{destination_path}")
    document, binary_chunk = read_glb(source_path)

    buffers = document.setdefault("buffers", [{"byteLength": 0}])
    if not isinstance(buffers, list) or not buffers or not isinstance(buffers[0], dict):
        raise RoomScanError("GLB 缺少有效的主 buffer。")
    if buffers[0].get("uri") is not None:
        raise RoomScanError("GLB 主 buffer 必须来自 BIN chunk。")
    for index, buffer in enumerate(buffers[1:], start=1):
        if not isinstance(buffer, dict):
            raise RoomScanError(f"GLB buffers[{index}] 必须是 buffer 对象。")
        uri = buffer.get("uri")
        if not isinstance(uri, str) or not uri.startswith("data:"):
            raise RoomScanError(
                f"GLB buffers[{index}] 必须是自包含的 data: URI，不能引用外部 buffer。"
            )
    declared_binary = buffers[0].get("byteLength", 0)
    if not isinstance(declared_binary, int) or not 0 <= declared_binary <= len(binary_chunk):
        raise RoomScanError("GLB buffer.byteLength 无效。")
    payload = bytearray(binary_chunk[:declared_binary])
    buffer_views = document.setdefault("bufferViews", [])
    images = document.get("images", [])
    if not isinstance(buffer_views, list) or not isinstance(images, list):
        raise RoomScanError("GLB images/bufferViews 结构无效。")

    embedded = 0
    for index, image in enumerate(images):
        if not isinstance(image, dict):
            raise RoomScanError(f"GLB images[{index}] 不是对象。")
        uri = image.get("uri")
        if uri is None:
            continue
        if not isinstance(uri, str):
            raise RoomScanError(f"GLB images[{index}].uri 不是字符串。")
        texture_path = _resolve_glb_image_uri(source_path, uri, root)
        try:
            image_data = texture_path.read_bytes()
        except OSError as error:
            raise RoomScanError(f"无法读取 GLB 纹理：{texture_path}：{error}") from error
        mime_type = _image_mime_type(texture_path, image_data)
        while len(payload) % 4:
            payload.append(0)
        byte_offset = len(payload)
        payload.extend(image_data)
        buffer_views.append(
            {"buffer": 0, "byteOffset": byte_offset, "byteLength": len(image_data)}
        )
        image.pop("uri", None)
        image["bufferView"] = len(buffer_views) - 1
        image["mimeType"] = mime_type
        image.setdefault("name", texture_path.stem)
        embedded += 1

    buffers[0]["byteLength"] = len(payload)
    json_bytes = json.dumps(
        document, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    binary_bytes = bytes(payload)
    binary_padded = binary_bytes + b"\x00" * ((-len(binary_bytes)) % 4)
    total_length = 12 + 8 + len(json_bytes)
    if binary_padded:
        total_length += 8 + len(binary_padded)
    output = bytearray(struct.pack("<4sII", GLB_MAGIC, GLB_VERSION, total_length))
    output.extend(struct.pack("<II", len(json_bytes), GLB_JSON_CHUNK))
    output.extend(json_bytes)
    if binary_padded:
        output.extend(struct.pack("<II", len(binary_padded), GLB_BIN_CHUNK))
        output.extend(binary_padded)

    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=destination_path.parent,
            prefix=f".{destination_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_path = ensure_within(
                Path(handle.name), root, "GLB 临时输出"
            )
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        # Validate the complete temporary container before it becomes visible
        # at the final path. os.replace then makes the hand-off atomic.
        read_glb(temporary_path)
        if destination_path.exists() and not allow_existing:
            raise RoomScanError(f"目标 GLB 已存在，已拒绝覆盖：{destination_path}")
        _replace_with_retry(temporary_path, destination_path)
        temporary_path = None
    except RoomScanError:
        raise
    except OSError as error:
        raise RoomScanError(f"无法写入内嵌纹理 GLB：{destination_path}：{error}") from error
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                # Preserve the primary error. This hidden unique file was never
                # exposed as the final model path.
                pass
    packed_document, _ = read_glb(destination_path)
    if any(isinstance(image, dict) and "uri" in image for image in packed_document.get("images", [])):
        raise RoomScanError(f"内嵌 GLB 仍包含外部纹理 URI：{destination_path}")
    return embedded


def _format_fields(template: Sequence[str]) -> set[str]:
    fields: set[str] = set()
    formatter = Formatter()
    for token in template:
        try:
            parsed = formatter.parse(token)
            for _, field_name, format_spec, conversion in parsed:
                if field_name is None:
                    continue
                if format_spec or conversion:
                    raise RoomScanError("Brush 模板不允许格式说明符或 ! 转换。")
                if field_name not in BRUSH_TEMPLATE_FIELDS:
                    raise RoomScanError(f"Brush 模板包含未知占位符：{field_name}")
                fields.add(field_name)
        except ValueError as error:
            raise RoomScanError(f"Brush 模板花括号格式错误：{token}") from error
    return fields


def parse_brush_template(raw: str | None, default_profile: str = "v0.3") -> list[str]:
    if raw is None:
        if default_profile not in BRUSH_PROFILES:
            raise RoomScanError(f"未知 Brush CLI 档位：{default_profile}")
        template = list(BRUSH_PROFILES[default_profile])
    else:
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise RoomScanError(
                f"Brush 模板必须是 JSON 字符串数组：第 {error.lineno} 行格式错误。"
            ) from error
        if not isinstance(value, list) or not value or not all(
            isinstance(item, str) and item for item in value
        ):
            raise RoomScanError("Brush 模板必须是非空 JSON 字符串数组。")
        template = list(value)

    fields = _format_fields(template)
    required = {"dataset", "output", "ply_name"}
    missing = required - fields
    if missing:
        raise RoomScanError(
            "Brush 模板缺少用于安全输入/输出校验的占位符："
            + ", ".join(f"{{{name}}}" for name in sorted(missing))
        )
    return template


def load_brush_template(
    inline_template: str | None,
    template_file: str | None,
    default_profile: str = "v0.3",
) -> tuple[list[str], str]:
    if inline_template and template_file:
        raise RoomScanError("--brush-template 与 --brush-template-file 只能选择一个。")
    if template_file:
        path = Path(template_file).expanduser().resolve(strict=False)
        if not path.is_file():
            raise RoomScanError(f"Brush 模板文件不存在：{path}")
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as error:
            raise RoomScanError(f"无法读取 Brush 模板文件：{error}") from error
        return parse_brush_template(raw), f"文件 {path}"
    if inline_template:
        return parse_brush_template(inline_template), "--brush-template"
    env_template = os.environ.get("BRUSH_ARGS_TEMPLATE")
    if env_template:
        return parse_brush_template(env_template), "环境变量 BRUSH_ARGS_TEMPLATE"
    return (
        parse_brush_template(None, default_profile=default_profile),
        f"内置 {default_profile} 模板",
    )


def inspect_brush_profile(executable: str, requested: str, dry_run: bool) -> str:
    """Choose a Brush CLI profile using --help, then a conservative filename fallback."""

    if requested in BRUSH_PROFILES:
        return requested
    if requested != "auto":
        raise RoomScanError(f"未知 Brush CLI 档位：{requested}")

    if not dry_run:
        try:
            completed = subprocess.run(
                [executable, "--help"],
                check=False,
                shell=False,
                capture_output=True,
                text=True,
                timeout=12,
            )
            help_text = f"{completed.stdout}\n{completed.stderr}"
            if "--total-train-iters" in help_text:
                return "main"
            if "--total-steps" in help_text:
                return "v0.3"
        except (OSError, subprocess.TimeoutExpired):
            pass

    basename = Path(executable).name.lower().replace("-", "_")
    if basename in {"brush_app", "brush_app.exe"}:
        return "v0.3"
    if basename in {"brush", "brush.exe", "brush_cli", "brush_cli.exe"}:
        return "main"
    if dry_run:
        print("[dry-run] 无法探测 Brush 帮助，按当前正式版 v0.3.0 生成命令。")
        return "v0.3"
    raise RoomScanError(
        "无法从 Brush --help 判断训练参数。请添加 --brush-profile v0.3/main，"
        "或用 --brush-template-file 提供经过核对的参数模板。"
    )


def expand_brush_template(
    template: Sequence[str], values: Mapping[str, str | int]
) -> list[str]:
    _format_fields(template)
    text_values = {key: str(value) for key, value in values.items()}
    try:
        return [token.format_map(text_values) for token in template]
    except KeyError as error:
        raise RoomScanError(f"Brush 模板缺少占位符值：{error.args[0]}") from error


def build_brush_command(
    executable: str,
    template: Sequence[str],
    paths: DatasetPaths,
    project: str,
    iterations: int,
    max_resolution: int,
    ply_name: str,
) -> list[str]:
    ply_path = ensure_within(paths.brush_output / ply_name, paths.project, "PLY 输出")
    values: dict[str, str | int] = {
        "dataset": _path_text(paths.project),
        "output": _path_text(paths.brush_output),
        "ply": _path_text(ply_path),
        "ply_name": ply_name,
        "project": project,
        "iterations": iterations,
        "max_resolution": max_resolution,
    }
    return [executable, *expand_brush_template(template, values)]


def command_doctor(args: argparse.Namespace) -> int:
    print("Room Scan 环境检查")
    print(f"工作目录：{SCANNER_DIR}")
    all_ok = True

    python_ok = sys.version_info >= MIN_PYTHON
    all_ok &= python_ok
    python_state = "OK" if python_ok else "缺失"
    print(
        f"[{python_state}] Python {sys.version.split()[0]} "
        f"（要求 >= {MIN_PYTHON[0]}.{MIN_PYTHON[1]}）"
    )

    try:
        cv2 = importlib.import_module("cv2")
        print(f"[OK] OpenCV {getattr(cv2, '__version__', '版本未知')}")
    except (ImportError, OSError) as error:
        all_ok = False
        print(f"[缺失] OpenCV：{error}")
        print("       安装：py -3 -m pip install -r scanner\\requirements.txt")

    for result, option, env_name in (
        (locate_colmap(args.colmap), "--colmap", "COLMAP_EXE"),
        (locate_brush(args.brush), "--brush", "BRUSH_EXE"),
    ):
        if result.ok:
            print(f"[OK] {result.name}：{result.executable}")
            probe_env = (
                colmap_runtime_environment(result.executable or "")
                if result.name == "COLMAP"
                else None
            )
            print(f"     {probe_version(result.executable or '', env=probe_env)}")
            if result.name == "Brush":
                try:
                    profile = inspect_brush_profile(
                        result.executable or "", "auto", dry_run=False
                    )
                    parameter = (
                        "--total-steps"
                        if profile == "v0.3"
                        else "--total-train-iters"
                    )
                    print(f"     CLI 档位：{profile}（{parameter}）")
                except RoomScanError as error:
                    all_ok = False
                    print(f"     [警告] {error}")
        else:
            all_ok = False
            print(f"[缺失] {result.name}：{result.detail}")
            print(f"       可使用 {option} 或环境变量 {env_name} 指定 .exe。")

    openmvs = locate_openmvs(getattr(args, "openmvs", None))
    if openmvs.ok:
        print(f"[OK·可选] OpenMVS CPU 工具组：{openmvs.detail}")
    else:
        print(f"[可选缺失] OpenMVS CPU 工具组：{openmvs.detail}")
        print("           不影响原有 4 项检查；只影响 cpu-reconstruct 命令。")

    if all_ok:
        print("检查通过：可以开始 capture → prepare → train。")
        if openmvs.ok:
            print("OpenMVS 也已就绪，可改用 cpu-reconstruct 生成纹理网格。")
        return 0
    print("检查未通过：请按上方提示补齐环境后重新运行 doctor。")
    return 1


def _require_positive(value: int | float, label: str, allow_zero: bool = False) -> None:
    if value < 0 or (value == 0 and not allow_zero):
        suffix = "非负数" if allow_zero else "正数"
        raise RoomScanError(f"{label}必须是{suffix}。")


def command_capture(args: argparse.Namespace) -> int:
    paths = dataset_paths(args.dataset_root, args.project)
    _require_positive(args.camera, "摄像头编号", allow_zero=True)
    _require_positive(args.width, "请求宽度", allow_zero=True)
    _require_positive(args.height, "请求高度", allow_zero=True)
    _require_positive(args.interval, "保存间隔")
    _require_positive(args.sharpness, "清晰度阈值", allow_zero=True)
    _require_positive(args.max_frames, "最大帧数", allow_zero=True)
    if not 1 <= args.jpeg_quality <= 100:
        raise RoomScanError("JPEG 质量必须在 1 到 100 之间。")

    print(f"项目：{args.project}")
    print(f"图像将保存到：{paths.images}")
    print(
        f"摄像头={args.camera}，分辨率={args.width}x{args.height}，"
        f"间隔={args.interval:.2f}s，清晰度阈值={args.sharpness:.1f}"
    )
    if args.dry_run:
        print("[dry-run] 未创建目录、未导入 OpenCV、未打开摄像头。")
        return 0

    try:
        cv2 = importlib.import_module("cv2")
    except (ImportError, OSError) as error:
        raise RoomScanError(
            "无法导入 OpenCV。请先运行："
            "py -3 -m pip install -r scanner\\requirements.txt"
        ) from error

    try:
        paths.images.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise RoomScanError(f"无法创建图像目录：{error}") from error

    backend = None
    if args.backend == "dshow":
        backend = getattr(cv2, "CAP_DSHOW", None)
    elif args.backend == "msmf":
        backend = getattr(cv2, "CAP_MSMF", None)
    try:
        capture = (
            cv2.VideoCapture(args.camera, backend)
            if backend is not None
            else cv2.VideoCapture(args.camera)
        )
    except cv2.error as error:
        raise RoomScanError(
            "OpenCV 无法初始化摄像头。请检查 Windows 摄像头权限和驱动。"
        ) from error
    if not capture.isOpened():
        capture.release()
        raise RoomScanError(
            f"无法打开摄像头 {args.camera}。请关闭占用摄像头的软件，"
            "或用 --camera 1 尝试其他设备。"
        )

    if args.width > 0:
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    if args.height > 0:
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)

    window = "Room Scan Capture"
    recording = False
    saved = 0
    blurred = 0
    frame_index = next_frame_index(paths.images)
    last_check = 0.0
    read_failures = 0
    resolution_reported = False
    print(
        "按键：空格 = 自动采集开始/暂停，S = 手动保存当前清晰帧，"
        "Q 或 Esc = 安全退出。程序初始为暂停状态。"
    )

    try:
        cv2.namedWindow(window, cv2.WINDOW_NORMAL)
        while True:
            ok, frame = capture.read()
            if not ok or frame is None:
                read_failures += 1
                if read_failures >= 30:
                    raise RoomScanError("连续读取摄像头失败，请检查设备连接。")
                time.sleep(0.03)
                continue
            read_failures = 0

            if not resolution_reported:
                resolution_reported = True
                shape = getattr(frame, "shape", ())
                if len(shape) >= 2:
                    actual_height, actual_width = int(shape[0]), int(shape[1])
                    print(f"摄像头实际输出：{actual_width}x{actual_height}")
                    if (
                        (args.width > 0 and actual_width != args.width)
                        or (args.height > 0 and actual_height != args.height)
                    ):
                        print(
                            "提示：摄像头没有采用请求的分辨率，已使用设备实际输出；"
                            "正式扫描前请检查驱动或尝试其他 --backend。"
                        )

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
            now = time.monotonic()
            if recording and now - last_check >= args.interval:
                last_check = now
                if sharpness >= args.sharpness:
                    target, frame_index = save_capture_frame(
                        cv2,
                        frame,
                        paths.images,
                        frame_index,
                        args.jpeg_quality,
                    )
                    saved += 1
                    print(f"已保存 {target.name}（清晰度 {sharpness:.1f}）")
                    if args.max_frames and saved >= args.max_frames:
                        print(f"已达到 --max-frames={args.max_frames}，自动结束。")
                        break
                else:
                    blurred += 1

            state = "REC" if recording else "PAUSED"
            color = (40, 205, 80) if recording else (0, 190, 255)
            # Draw status only on the preview copy.  The original frame must stay
            # clean because a later S key press may save it for COLMAP training.
            preview = frame.copy() if hasattr(frame, "copy") else frame
            cv2.putText(
                preview,
                f"{state}  saved={saved}  sharp={sharpness:.1f}",
                (18, 34),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.75,
                color,
                2,
                cv2.LINE_AA,
            )
            cv2.putText(
                preview,
                "SPACE auto | S save frame | Q/ESC quit",
                (18, 66),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.58,
                (245, 245, 245),
                1,
                cv2.LINE_AA,
            )
            cv2.imshow(window, preview)
            key = cv2.waitKey(1) & 0xFF
            if key == 32:
                recording = not recording
                if recording:
                    last_check = 0.0
                print("开始采集。" if recording else "已暂停采集。")
            elif key in (ord("s"), ord("S")):
                if sharpness < args.sharpness:
                    print(
                        f"当前帧清晰度 {sharpness:.1f} 低于阈值 "
                        f"{args.sharpness:.1f}，未保存。"
                    )
                else:
                    target, frame_index = save_capture_frame(
                        cv2,
                        frame,
                        paths.images,
                        frame_index,
                        args.jpeg_quality,
                    )
                    saved += 1
                    print(f"手动保存 {target.name}（清晰度 {sharpness:.1f}）")
                    if args.max_frames and saved >= args.max_frames:
                        print(f"已达到 --max-frames={args.max_frames}，自动结束。")
                        break
            elif key in (ord("q"), ord("Q"), 27):
                break
            try:
                if cv2.getWindowProperty(window, cv2.WND_PROP_VISIBLE) < 1:
                    break
            except cv2.error:
                pass
    except cv2.error as error:
        raise RoomScanError(
            "OpenCV 摄像头预览失败。请检查 Windows 摄像头权限、驱动和图形桌面环境。"
            f"原始信息：{error}"
        ) from error
    finally:
        capture.release()
        try:
            cv2.destroyAllWindows()
        except cv2.error:
            pass

    print(f"采集结束：本次保存 {saved} 帧，因模糊跳过 {blurred} 次。")
    print(f"图像目录：{paths.images}")
    if saved == 0:
        print("提示：本次没有保存帧；请确认曾按空格开始采集。")
    return 0


def command_import_video(args: argparse.Namespace) -> int:
    paths = dataset_paths(args.dataset_root, args.project)
    _require_positive(args.target_fps, "目标采样帧率")
    _require_positive(args.sharpness, "清晰度阈值", allow_zero=True)
    _require_positive(args.motion_threshold, "运动差异阈值", allow_zero=True)
    _require_positive(args.max_frames, "最大帧数", allow_zero=True)
    _require_positive(args.max_width, "最大图像宽度", allow_zero=True)
    if not 1 <= args.jpeg_quality <= 100:
        raise RoomScanError("JPEG 质量必须在 1 到 100 之间。")

    try:
        source = Path(args.video).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise RoomScanError(f"视频文件不存在或无法访问：{args.video}") from error
    if not source.is_file():
        raise RoomScanError(f"视频路径不是普通文件：{source}")

    existing_entries: list[Path] = []
    if paths.images.is_dir():
        try:
            existing_entries = list(paths.images.iterdir())
        except OSError as error:
            raise RoomScanError(f"无法检查图像目录：{error}") from error
    elif paths.images.exists():
        existing_entries = [paths.images]
    if existing_entries and not args.allow_existing:
        preview = "、".join(path.name for path in existing_entries[:5])
        suffix = "……" if len(existing_entries) > 5 else ""
        raise RoomScanError(
            f"图像目录已有内容：{preview}{suffix}。为避免混入或覆盖旧素材，"
            "已拒绝导入；要追加连续编号的新帧时请明确添加 --allow-existing。"
        )

    width_text = "保留原始宽度" if args.max_width == 0 else f"最大宽度 {args.max_width}"
    frame_limit = "不限" if args.max_frames == 0 else str(args.max_frames)
    print(f"项目：{args.project}")
    print(f"只读视频源：{source}")
    print(f"图像将保存到：{paths.images}")
    print(
        f"目标 {args.target_fps:g} fps，清晰度阈值 {args.sharpness:g}，"
        f"运动差异阈值 {args.motion_threshold:g}，{width_text}，"
        f"最多保存 {frame_limit} 帧"
    )
    if args.allow_existing and existing_entries:
        print("追加模式：保留旧文件，从下一个可用 frame 编号开始，不覆盖旧帧。")
    if args.dry_run:
        print("[dry-run] 已校验源视频和路径；未导入 OpenCV、未解码、未创建目录。")
        return 0

    try:
        cv2 = importlib.import_module("cv2")
    except (ImportError, OSError) as error:
        raise RoomScanError(
            "无法导入 OpenCV。请先运行："
            "py -3 -m pip install -r scanner\\requirements.txt"
        ) from error

    capture = None
    created: list[Path] = []
    manifest_path: Path | None = None
    manifest_created = False
    try:
        paths.images.mkdir(parents=True, exist_ok=True)
        capture = cv2.VideoCapture(str(source))
        if not capture.isOpened():
            raise RoomScanError(
                "OpenCV 无法打开视频。请确认文件未损坏，并安装了支持该编码的 OpenCV。"
            )

        orientation_property = getattr(cv2, "CAP_PROP_ORIENTATION_AUTO", None)
        if orientation_property is not None:
            capture.set(orientation_property, 1)

        source_fps = float(capture.get(cv2.CAP_PROP_FPS))
        if not math.isfinite(source_fps) or source_fps <= 0:
            source_fps = 30.0
            print("警告：视频没有可靠帧率元数据，按 30 fps 进行采样。")
        total_metadata = float(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        total_frames = (
            int(total_metadata)
            if math.isfinite(total_metadata) and total_metadata > 0
            else 0
        )
        duration = total_frames / source_fps if total_frames else 0.0
        duration_text = f"，约 {duration:.1f} 秒" if duration else ""
        print(
            f"视频元数据：{source_fps:.3f} fps，"
            f"{total_frames if total_frames else '未知'} 帧{duration_text}。"
        )

        effective_target_fps = min(args.target_fps, source_fps)
        if effective_target_fps != args.target_fps:
            print(
                f"提示：目标帧率高于视频帧率，已按 {effective_target_fps:g} fps 处理。"
            )
        decoded = 0
        analyzed = 0
        quality_windows = 0
        blurry_candidate_frames = 0
        duplicate_candidate_frames = 0
        blurry_windows = 0
        duplicate_windows = 0
        saved = 0
        frame_index = next_frame_index(paths.images)
        last_accepted_thumbnail = None
        output_size: tuple[int, int] | None = None
        source_size: tuple[int, int] | None = None
        current_window: int | None = None
        window_frame_count = 0
        window_sharp_candidates = 0
        best_frame = None
        best_thumbnail = None
        best_sharpness = -1.0
        stopped_early = False

        def flush_best_window() -> bool:
            nonlocal quality_windows, blurry_windows, duplicate_windows
            nonlocal saved, frame_index, last_accepted_thumbnail, output_size
            nonlocal window_frame_count, window_sharp_candidates
            nonlocal best_frame, best_thumbnail, best_sharpness
            if window_frame_count == 0:
                return False
            quality_windows += 1
            if best_frame is None:
                if window_sharp_candidates == 0:
                    blurry_windows += 1
                else:
                    duplicate_windows += 1
            else:
                resized = _resize_video_frame(cv2, best_frame, args.max_width)
                shape = getattr(resized, "shape", ())
                if output_size is None and len(shape) >= 2:
                    output_size = (int(shape[1]), int(shape[0]))
                    print(f"导出图像尺寸：{output_size[0]}x{output_size[1]}")
                while True:
                    target = paths.images / f"frame_{frame_index:06d}.jpg"
                    frame_index += 1
                    if not target.exists():
                        break
                atomic_write_video_frame(cv2, resized, target, args.jpeg_quality)
                created.append(target)
                saved += 1
                last_accepted_thumbnail = best_thumbnail
                if saved == 1 or saved % 25 == 0:
                    print(
                        f"进度：已解码 {decoded} 帧，保存 {saved} 帧；"
                        f"最近窗口最佳清晰度 {best_sharpness:.1f}"
                    )
            window_frame_count = 0
            window_sharp_candidates = 0
            best_frame = None
            best_thumbnail = None
            best_sharpness = -1.0
            return bool(args.max_frames and saved >= args.max_frames)

        while True:
            ok, frame = capture.read()
            if not ok or frame is None:
                break
            current_index = decoded
            decoded += 1
            window_index = int(
                math.floor(
                    current_index * effective_target_fps / source_fps + 1e-12
                )
            )
            if current_window is None:
                current_window = window_index
            elif window_index != current_window:
                if flush_best_window():
                    stopped_early = True
                    print(f"已达到 --max-frames={args.max_frames}，提前停止解码。")
                    break
                current_window = window_index

            shape = getattr(frame, "shape", ())
            if source_size is None and len(shape) >= 2:
                source_size = (int(shape[1]), int(shape[0]))
                print(f"实际解码尺寸：{source_size[0]}x{source_size[1]}")
            window_frame_count += 1
            analyzed += 1
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
            if sharpness < args.sharpness:
                blurry_candidate_frames += 1
                continue

            window_sharp_candidates += 1
            thumbnail = _video_motion_thumbnail(cv2, gray)
            if last_accepted_thumbnail is not None:
                motion = _video_motion_difference(
                    cv2, thumbnail, last_accepted_thumbnail
                )
                if motion < args.motion_threshold:
                    duplicate_candidate_frames += 1
                    continue
            if sharpness > best_sharpness:
                best_frame = frame
                best_thumbnail = thumbnail
                best_sharpness = sharpness

        if not stopped_early:
            flush_best_window()
        if decoded == 0:
            raise RoomScanError("视频已打开，但没有解码出任何画面。")
        if saved == 0:
            raise RoomScanError(
                "没有任何时间窗口选出合格帧。请降低 --sharpness 或 "
                "--motion-threshold 后重试。"
            )

        manifest_path = next_video_manifest_path(paths.project)
        manifest = {
            "schema_version": 1,
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "project": args.project,
            "source": {
                "path": str(source),
                "bytes": source.stat().st_size,
                "copied_into_dataset": False,
                "fps": source_fps,
                "frame_count_metadata": total_frames or None,
                "duration_seconds": duration or None,
                "decoded_width": source_size[0] if source_size else None,
                "decoded_height": source_size[1] if source_size else None,
            },
            "settings": {
                "selection": "sharpest_eligible_frame_per_time_window",
                "target_fps": args.target_fps,
                "effective_target_fps": effective_target_fps,
                "window_seconds": 1.0 / effective_target_fps,
                "sharpness_threshold": args.sharpness,
                "sharpness_metric": (
                    "variance_of_laplacian_on_original_decoded_grayscale"
                ),
                "motion_difference_threshold": args.motion_threshold,
                "motion_metric": "mean_absolute_difference_on_256x144_grayscale",
                "max_frames": args.max_frames,
                "max_width": args.max_width,
                "jpeg_quality": args.jpeg_quality,
            },
            "result": {
                "decoded_frames": decoded,
                "analyzed_frames": analyzed,
                "quality_windows": quality_windows,
                "below_sharpness_candidate_frames": blurry_candidate_frames,
                "below_motion_candidate_frames": duplicate_candidate_frames,
                "all_blurry_windows": blurry_windows,
                "all_near_duplicate_windows": duplicate_windows,
                "saved_frames": saved,
                "first_frame": created[0].name,
                "last_frame": created[-1].name,
                "output_width": output_size[0] if output_size else None,
                "output_height": output_size[1] if output_size else None,
                "stopped_at_max_frames": stopped_early,
            },
            "output": {
                "images_directory": str(paths.images),
                "manifest": str(manifest_path),
            },
        }
        atomic_write_json(manifest_path, manifest)
        manifest_created = True
    except (Exception, KeyboardInterrupt):
        if manifest_created and manifest_path is not None and manifest_path.exists():
            try:
                manifest_path.unlink()
            except OSError:
                print(
                    f"警告：失败清理时无法删除本次清单：{manifest_path}",
                    file=sys.stderr,
                )
        if created:
            print(
                f"导入失败，正在清理本次新建的 {len(created)} 帧；旧文件保持不变。",
                file=sys.stderr,
            )
            _remove_imported_frames(created)
        raise
    finally:
        if capture is not None:
            capture.release()

    print("视频导入完成：")
    print(f"  - 已解码：{decoded} 帧")
    print(f"  - 已分析：{analyzed} 帧")
    print(f"  - 时间窗口：{quality_windows} 个")
    print(f"  - 低于清晰度阈值：{blurry_candidate_frames} 帧")
    print(f"  - 低于运动差异阈值：{duplicate_candidate_frames} 帧")
    print(f"  - 全部模糊而跳过：{blurry_windows} 个窗口")
    print(f"  - 全部近重复而跳过：{duplicate_windows} 个窗口")
    print(f"  - 最终保存：{saved} 帧")
    print(f"  - 图像目录：{paths.images}")
    print(f"  - 可复现清单：{manifest_path}")
    print("源视频只以读取方式打开，未被修改。")
    return 0


def command_prepare(args: argparse.Namespace) -> int:
    paths = dataset_paths(args.dataset_root, args.project)
    _require_positive(args.min_images, "最少图像数")

    if args.dry_run:
        located = locate_colmap(args.colmap)
        executable = (
            located.executable
            or args.colmap
            or os.environ.get("COLMAP_EXE")
            or "colmap.exe"
        )
    else:
        executable = require_tool(locate_colmap(args.colmap), "--colmap", "COLMAP_EXE")
        images = image_files(paths.images)
        if len(images) < args.min_images:
            raise RoomScanError(
                f"图像不足：{paths.images} 中只有 {len(images)} 张，"
                f"至少需要 {args.min_images} 张。请先运行 capture。"
            )
        existing = [
            path
            for path in (paths.project / "database.db", paths.sparse)
            if path.exists()
        ]
        if existing and not args.allow_existing:
            joined = "、".join(str(path) for path in existing)
            raise RoomScanError(
                f"检测到已有 COLMAP 输出：{joined}。为避免覆盖已拒绝执行；"
                "确认要继续时添加 --allow-existing（本工具仍不会删除文件）。"
            )

    command = build_colmap_command(
        executable,
        paths,
        quality=args.quality,
        camera_model=args.camera_model,
    )
    print("COLMAP 配置：视频序列匹配、单相机、仅稀疏重建、CPU 模式。")
    colmap_env = None if args.dry_run else colmap_runtime_environment(executable)
    run_external(command, paths.project, args.dry_run, env=colmap_env)
    if args.dry_run:
        return 0

    models = find_colmap_models(paths.sparse)
    if not models:
        raise RoomScanError(
            "COLMAP 命令已结束，但没有检测到 cameras/images/points3D 模型文件。"
            "这不视为成功；请检查上方日志、图像重叠率和画面清晰度。"
        )
    print(f"COLMAP 稀疏重建完成，共检测到 {len(models)} 个模型：")
    for model in models:
        print(f"  - {model}")
    return 0


def command_audit_sparse(args: argparse.Namespace) -> int:
    """Read and quality-gate all connected COLMAP sparse models."""

    paths = dataset_paths(args.dataset_root, args.project)
    try:
        report = audit_sparse_project(
            paths.project,
            min_registration_ratio=args.min_registration_ratio,
            max_reprojection_error_px=args.max_reprojection_error,
            min_average_track_length=args.min_track_length,
        )
    except SparseAuditError as error:
        raise RoomScanError(str(error)) from error
    print(report.to_json() if args.json else format_sparse_audit(report))
    return 0 if report.passes else 3


def command_prepare_video(args: argparse.Namespace) -> int:
    """Run an explicit high-quality CPU sparse pipeline for ordered video frames."""

    paths = dataset_paths(args.dataset_root, args.project)
    _require_positive(args.min_images, "最少图像数")
    _require_positive(args.max_image_size, "SIFT 最大图像尺寸")
    _require_positive(args.max_num_features, "SIFT 最大特征数")
    _require_positive(args.overlap, "顺序匹配重叠帧数")
    if args.max_threads is not None:
        _require_positive(args.max_threads, "COLMAP 最大线程数")
    if not 0 <= args.quality_threshold <= 100:
        raise RoomScanError("注册率质量门槛必须在 0 到 100 之间。")

    if args.vocab_tree and not args.loop_detection:
        raise RoomScanError(
            "--vocab-tree 只能与 --loop-detection 一起使用。"
        )
    vocab_tree_path: Path | None = None
    if args.loop_detection:
        if not args.vocab_tree:
            raise RoomScanError(
                "启用 --loop-detection 时必须同时提供 --vocab-tree PATH。"
            )
        try:
            vocab_tree_path = Path(args.vocab_tree).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise RoomScanError(
                f"vocabulary tree 文件不存在或无法访问：{args.vocab_tree}"
            ) from error
        if not vocab_tree_path.is_file():
            raise RoomScanError(
                f"vocabulary tree 路径不是普通文件：{vocab_tree_path}"
            )
        try:
            with vocab_tree_path.open("rb"):
                pass
        except OSError as error:
            raise RoomScanError(
                f"vocabulary tree 文件不可读：{vocab_tree_path}"
            ) from error

    if args.dry_run:
        located = locate_colmap(args.colmap)
        executable = (
            located.executable
            or args.colmap
            or os.environ.get("COLMAP_EXE")
            or "colmap.exe"
        )
        images: list[Path] = []
    else:
        executable = require_tool(locate_colmap(args.colmap), "--colmap", "COLMAP_EXE")
        images = image_files(paths.images)
        if len(images) < args.min_images:
            raise RoomScanError(
                f"图像不足：{paths.images} 中只有 {len(images)} 张，"
                f"至少需要 {args.min_images} 张。请先运行 import-video。"
            )
        existing = [
            path
            for path in (paths.project / "database.db", paths.sparse)
            if path.exists()
        ]
        if existing and not args.allow_existing:
            joined = "、".join(str(path) for path in existing)
            raise RoomScanError(
                f"检测到已有 COLMAP 输出：{joined}。为避免覆盖已拒绝执行；"
                "确认要继续时添加 --allow-existing（本工具仍不会删除文件）。"
            )

    commands = build_colmap_video_commands(
        executable,
        paths,
        max_image_size=args.max_image_size,
        max_num_features=args.max_num_features,
        affine_shape=args.affine_shape,
        domain_size_pooling=args.domain_size_pooling,
        overlap=args.overlap,
        quadratic_overlap=args.quadratic_overlap,
        max_threads=args.max_threads,
        loop_detection=args.loop_detection,
        vocab_tree_path=vocab_tree_path,
    )
    print(
        "COLMAP 高质量视频配置：单相机 SIMPLE_RADIAL、CPU SIFT、"
        "guided sequential matching、CPU mapper。"
    )
    print(
        f"质量门槛：最佳连通模型须注册至少 {args.quality_threshold:.1f}% "
        "的导入图像。"
    )
    if args.max_threads is None:
        print("COLMAP 线程数：沿用程序默认值。")
    else:
        print(f"COLMAP 线程数上限：{args.max_threads}。")
    if args.loop_detection:
        print(f"回环检测已启用；只读使用 vocabulary tree：{vocab_tree_path}")
    else:
        print("回环检测已关闭；默认不做 exhaustive matching。")
    if not args.dry_run:
        paths.sparse.mkdir(parents=True, exist_ok=True)
    colmap_env = None if args.dry_run else colmap_runtime_environment(executable)
    for command in commands:
        run_external(command, paths.project, args.dry_run, env=colmap_env)
    if args.dry_run:
        return 0

    report = analyze_sparse_quality(
        paths.sparse,
        total_images=len(images),
        threshold_percent=args.quality_threshold,
    )
    print_sparse_quality_report(report)
    if report.passed:
        print("[质量门槛通过] 可以继续进行稠密点云、网格或 3DGS 重建。")
        return 0
    print(
        "[质量门槛未通过] 稀疏模型、database.db 和全部中间结果均已保留，"
        "不会自动删除；建议先改善抽帧/拍摄连贯性，再决定是否继续稠密重建。",
        file=sys.stderr,
    )
    return QUALITY_GATE_EXIT_CODE


def command_cpu_reconstruct(args: argparse.Namespace) -> int:
    paths = dataset_paths(args.dataset_root, args.project)
    cpu_paths = cpu_reconstruction_paths(paths, args.project)
    profile = CPU_RECONSTRUCTION_PRESETS[args.preset]
    max_resolution = (
        args.max_resolution
        if args.max_resolution is not None
        else profile.max_resolution
    )
    min_resolution = (
        args.min_resolution
        if args.min_resolution is not None
        else profile.min_resolution
    )
    available_threads = max(1, os.cpu_count() or 1)
    default_threads = (
        min(available_threads, profile.thread_cap)
        if profile.thread_cap is not None
        else available_threads
    )
    max_threads = args.max_threads if args.max_threads is not None else default_threads
    _require_positive(max_resolution, "最大分辨率")
    _require_positive(min_resolution, "最小分辨率")
    _require_positive(max_threads, "最大线程数")
    if min_resolution > max_resolution:
        raise RoomScanError("最小分辨率不能大于最大分辨率。")

    if args.dry_run:
        located_colmap = locate_colmap(args.colmap)
        colmap_executable = (
            located_colmap.executable
            or args.colmap
            or os.environ.get("COLMAP_EXE")
            or "colmap.exe"
        )
        openmvs = openmvs_tools_for_dry_run(args.openmvs)
        model_number = args.model_index if args.model_index is not None else 0
        sparse_model = paths.sparse / str(model_number)
        print("[dry-run] 未读取模型统计；仅用 sparse\\0（或 --model-index）展示命令。")
    else:
        colmap_executable = require_tool(
            locate_colmap(args.colmap), "--colmap", "COLMAP_EXE"
        )
        openmvs = require_openmvs(locate_openmvs(args.openmvs))
        if not image_files(paths.images):
            raise RoomScanError(f"未找到源图像：{paths.images}")
        sparse_model, ranked = choose_colmap_model(paths.sparse, args.model_index)
        print("COLMAP 连通模型（按注册图像数排序）：")
        for model, count in ranked:
            marker = "  ← 已选择" if model == sparse_model else ""
            print(f"  - {model.name or model}：{count} 张{marker}")

        existing: list[Path] = []
        if cpu_paths.output.is_dir():
            try:
                existing = list(cpu_paths.output.iterdir())
            except OSError as error:
                raise RoomScanError(f"无法检查 OpenMVS 输出目录：{error}") from error
        elif cpu_paths.output.exists():
            existing = [cpu_paths.output]
        if existing and not args.allow_existing:
            preview = "、".join(path.name for path in existing[:5])
            suffix = "……" if len(existing) > 5 else ""
            raise RoomScanError(
                f"OpenMVS 输出目录已有内容：{preview}{suffix}。为避免覆盖已拒绝执行；"
                "确认续跑或重算时添加 --allow-existing（工具不会主动删除旧文件）。"
            )

    commands = build_cpu_reconstruction_commands(
        colmap_executable,
        openmvs,
        paths,
        cpu_paths,
        sparse_model,
        max_resolution=max_resolution,
        min_resolution=min_resolution,
        max_threads=max_threads,
        preset=args.preset,
    )
    print(
        "CPU 重建配置：COLMAP 去畸变 → OpenMVS 稠密点云 → 网格 → 纹理 GLB，"
        "全程不要求 CUDA。"
    )
    print(
        f"参数预设：{args.preset}；最大/最小分辨率 "
        f"{max_resolution}/{min_resolution}；最大线程数 {max_threads}。"
    )
    if not args.dry_run:
        try:
            cpu_paths.colmap.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise RoomScanError(f"无法创建 OpenMVS 输出目录：{error}") from error

    colmap_env = None if args.dry_run else colmap_runtime_environment(colmap_executable)
    openmvs_env = None if args.dry_run else openmvs_runtime_environment(openmvs)
    run_external(commands[0], paths.project, args.dry_run, env=colmap_env)
    if not args.dry_run:
        if not find_colmap_models(cpu_paths.colmap / "sparse"):
            raise RoomScanError(
                "COLMAP 去畸变命令结束，但输出中没有有效 sparse 模型。"
            )

    validation_steps = (
        ((cpu_paths.scene, "OpenMVS 场景"),),
        (
            (cpu_paths.dense_scene, "OpenMVS 稠密场景"),
            (cpu_paths.dense_cloud, "OpenMVS 稠密点云"),
        ),
        ((cpu_paths.mesh, "OpenMVS 网格"),),
    )
    for command, expected_files in zip(commands[1:4], validation_steps):
        run_external(command, cpu_paths.output, args.dry_run, env=openmvs_env)
        if not args.dry_run:
            for expected, label in expected_files:
                validate_nonempty_file(expected, label)

    run_external(commands[4], cpu_paths.output, args.dry_run, env=openmvs_env)
    if args.dry_run:
        print(
            "[dry-run] 最后将校验 GLB v2，并把外部 PNG/JPEG 纹理打包为："
            f"{cpu_paths.embedded_glb}"
        )
        return 0

    read_glb(cpu_paths.textured_glb)
    embedded_count = embed_glb_images(
        cpu_paths.textured_glb,
        cpu_paths.embedded_glb,
        cpu_paths.output,
        allow_existing=args.allow_existing,
    )
    validate_nonempty_file(cpu_paths.dense_cloud, "OpenMVS 稠密点云")
    validate_nonempty_file(cpu_paths.mesh, "OpenMVS 网格")
    read_glb(cpu_paths.embedded_glb)
    print("CPU 纹理网格重建完成：")
    print(f"  - 稠密点云：{cpu_paths.dense_cloud}")
    print(f"  - 三角网格：{cpu_paths.mesh}")
    print(f"  - OpenMVS 原始 GLB：{cpu_paths.textured_glb}")
    print(
        f"  - 推荐使用的自包含 GLB：{cpu_paths.embedded_glb}"
        f"（已内嵌 {embedded_count} 张纹理）"
    )
    return 0


def command_train(args: argparse.Namespace) -> int:
    paths = dataset_paths(args.dataset_root, args.project)
    _require_positive(args.iterations, "训练迭代数")
    _require_positive(args.max_resolution, "最大分辨率")
    ply_name = validate_ply_name(args.ply_name or f"{args.project}.ply")
    if args.dry_run:
        located = locate_brush(args.brush)
        executable = (
            located.executable
            or args.brush
            or os.environ.get("BRUSH_EXE")
            or "brush_app.exe"
        )
    else:
        executable = require_tool(locate_brush(args.brush), "--brush", "BRUSH_EXE")
        if not image_files(paths.images):
            raise RoomScanError(f"未找到训练图像：{paths.images}")
        models = find_colmap_models(paths.sparse)
        if not models:
            raise RoomScanError(
                f"未找到有效 COLMAP 稀疏模型：{paths.sparse}。请先运行 prepare。"
            )

    has_custom_template = bool(
        args.brush_template
        or args.brush_template_file
        or os.environ.get("BRUSH_ARGS_TEMPLATE")
    )
    if has_custom_template:
        template, template_source = load_brush_template(
            args.brush_template, args.brush_template_file
        )
    else:
        profile = inspect_brush_profile(
            executable,
            args.brush_profile,
            dry_run=args.dry_run,
        )
        template, template_source = load_brush_template(
            None,
            None,
            default_profile=profile,
        )

    expected_ply = ensure_within(paths.brush_output / ply_name, paths.project, "PLY 输出")
    if not args.dry_run and expected_ply.exists() and not args.allow_existing:
        raise RoomScanError(
            f"目标 PLY 已存在：{expected_ply}。为避免覆盖已拒绝执行；"
            "请备份/改名，或明确添加 --allow-existing。"
        )

    command = build_brush_command(
        executable,
        template,
        paths,
        args.project,
        args.iterations,
        args.max_resolution,
        ply_name,
    )
    print(f"Brush 参数模板来源：{template_source}")
    print(
        "注意：Brush CLI 会随版本变化；本工具只在实际检测到导出的 PLY 后才报告成功。"
    )
    if not args.dry_run:
        try:
            paths.brush_output.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise RoomScanError(f"无法创建 Brush 输出目录：{error}") from error
    before_exports = {
        path.resolve(): (path.stat().st_mtime_ns, path.stat().st_size)
        for path in paths.brush_output.glob("*.ply")
        if path.is_file()
    } if paths.brush_output.is_dir() else {}
    run_external(command, paths.project, args.dry_run)
    if args.dry_run:
        return 0

    exported = sorted(paths.brush_output.glob("*.ply"))
    changed_exports = []
    for path in exported:
        signature = (path.stat().st_mtime_ns, path.stat().st_size)
        if before_exports.get(path.resolve()) != signature:
            changed_exports.append(path)
    if expected_ply.is_file() and expected_ply in changed_exports:
        print(f"Brush 训练与导出完成：{expected_ply}")
        return 0
    if changed_exports:
        print("[警告] Brush 未生成预期文件名，但检测到以下 PLY：")
        for path in changed_exports:
            print(f"  - {path}")
        print("请确认所用 Brush 版本的 --export-name 行为。")
        return 0
    raise RoomScanError(
        "Brush 命令已结束，但输出目录中没有 PLY，因此不视为成功。"
        "请运行 brush --help 核对版本参数，并通过 --brush-template-file 提供模板。"
    )


def add_project_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "project",
        nargs="?",
        default="room",
        help="项目名，默认 room；每个项目使用独立数据集目录",
    )
    parser.add_argument(
        "--dataset-root",
        default=os.environ.get("ROOM_SCAN_DATA_ROOT", str(DEFAULT_DATASET_ROOT)),
        help="数据集根目录；也可设置 ROOM_SCAN_DATA_ROOT",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅校验并显示计划，不创建目录、不打开摄像头、不执行外部程序",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = ChineseArgumentParser(
        prog="room_scan.py",
        description=(
            "室内摄像头/视频图像采集、COLMAP 稀疏重建、"
            "Brush 3DGS 与 OpenMVS CPU 网格工具"
        ),
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {APP_VERSION}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor", help="检查 Python、OpenCV、COLMAP 和 Brush")
    doctor.add_argument("--colmap", help="COLMAP.bat 或 bin\\colmap.exe 的路径")
    doctor.add_argument("--brush", help="Brush 可执行文件路径（如 brush.exe）")
    doctor.add_argument(
        "--openmvs", help="OpenMVS Release 目录（包含 4 个 CPU 重建程序）"
    )
    doctor.set_defaults(handler=command_doctor)

    capture = subparsers.add_parser("capture", help="用 OpenCV 摄像头采集清晰帧")
    add_project_arguments(capture)
    capture.add_argument("--camera", type=int, default=0, help="摄像头编号，默认 0")
    capture.add_argument(
        "--backend",
        choices=("auto", "dshow", "msmf"),
        default="auto",
        help="Windows 摄像头后端，默认 auto",
    )
    capture.add_argument("--width", type=int, default=1920, help="请求宽度，0 表示不设置")
    capture.add_argument("--height", type=int, default=1080, help="请求高度，0 表示不设置")
    capture.add_argument(
        "--interval", type=float, default=0.45, help="尝试保存清晰帧的间隔秒数"
    )
    capture.add_argument(
        "--sharpness",
        type=float,
        default=10.0,
        help="Laplacian 清晰度阈值，默认 10；0 表示不筛除模糊帧",
    )
    capture.add_argument(
        "--jpeg-quality", type=int, default=95, help="JPEG 质量 1-100，默认 95"
    )
    capture.add_argument(
        "--max-frames",
        type=int,
        default=600,
        help="保存到指定数量后停止，默认 600；0 表示不限",
    )
    capture.set_defaults(handler=command_capture)

    import_video = subparsers.add_parser(
        "import-video",
        help="从手机等本地视频按帧率、清晰度和运动差异筛选有序帧",
    )
    add_project_arguments(import_video)
    import_video.add_argument("video", help="要只读导入的本地视频文件路径")
    import_video.add_argument(
        "--target-fps",
        type=float,
        default=2.5,
        help="每秒输出时间窗口数，默认 2.5；每个窗口只选最清晰的合格帧",
    )
    import_video.add_argument(
        "--sharpness",
        type=float,
        default=10.0,
        help="原始灰度帧 Laplacian 最低清晰度，默认 10；0 表示关闭模糊筛选",
    )
    import_video.add_argument(
        "--motion-threshold",
        type=float,
        default=1.5,
        help="与上一已保存帧的最低画面差异，默认 1.5；0 表示保留近重复帧",
    )
    import_video.add_argument(
        "--max-frames",
        type=int,
        default=800,
        help="最多保存的帧数，默认 800；0 表示不限",
    )
    import_video.add_argument(
        "--max-width",
        type=int,
        default=2560,
        help="导出图像最大宽度，默认 2560；0 表示保留视频原始宽度",
    )
    import_video.add_argument(
        "--jpeg-quality", type=int, default=97, help="JPEG 质量 1-100，默认 97"
    )
    import_video.add_argument(
        "--allow-existing",
        action="store_true",
        help="允许向非空 images 目录追加；仍从新编号开始且绝不覆盖旧帧",
    )
    import_video.set_defaults(handler=command_import_video)

    prepare = subparsers.add_parser(
        "prepare", help="调用 COLMAP automatic_reconstructor 生成稀疏模型"
    )
    add_project_arguments(prepare)
    prepare.add_argument("--colmap", help="COLMAP.bat 或 bin\\colmap.exe 的路径")
    prepare.add_argument(
        "--quality",
        choices=("LOW", "MEDIUM", "HIGH", "EXTREME"),
        default="MEDIUM",
        help="COLMAP 自动重建质量，默认 MEDIUM",
    )
    prepare.add_argument(
        "--camera-model", default="SIMPLE_RADIAL", help="COLMAP 相机模型"
    )
    prepare.add_argument(
        "--min-images", type=int, default=20, help="开始重建所需的最少图像数"
    )
    prepare.add_argument(
        "--allow-existing",
        action="store_true",
        help="允许 COLMAP 在已有输出目录上继续；不会删除任何文件",
    )
    prepare.set_defaults(handler=command_prepare)

    audit_sparse = subparsers.add_parser(
        "audit-sparse",
        help="只读统计 COLMAP 连通模型并执行稀疏质量门槛",
    )
    audit_sparse.add_argument(
        "project", nargs="?", default="room", help="项目名，默认 room"
    )
    audit_sparse.add_argument(
        "--dataset-root",
        default=os.environ.get("ROOM_SCAN_DATA_ROOT", str(DEFAULT_DATASET_ROOT)),
        help="数据集根目录；也可设置 ROOM_SCAN_DATA_ROOT",
    )
    audit_sparse.add_argument(
        "--min-registration-ratio",
        type=float,
        default=0.85,
        help="最大单一连通模型的最低注册比例，默认 0.85",
    )
    audit_sparse.add_argument(
        "--max-reprojection-error",
        type=float,
        default=1.5,
        help="COLMAP 平均重投影误差上限（像素），默认 1.5",
    )
    audit_sparse.add_argument(
        "--min-track-length",
        type=float,
        default=3.0,
        help="稀疏点最低平均轨长，默认 3.0",
    )
    audit_sparse.add_argument(
        "--json", action="store_true", help="输出便于程序读取的 JSON"
    )
    audit_sparse.set_defaults(handler=command_audit_sparse)

    prepare_video = subparsers.add_parser(
        "prepare-video",
        help="用 COLMAP 4.1 显式高质量 CPU 流程重建手机视频稀疏模型",
    )
    add_project_arguments(prepare_video)
    prepare_video.add_argument(
        "--colmap", help="COLMAP.bat 或 bin\\colmap.exe 的路径"
    )
    prepare_video.add_argument(
        "--max-image-size",
        type=int,
        default=3200,
        help="SIFT 特征提取最大图像边长，默认 3200",
    )
    prepare_video.add_argument(
        "--max-num-features",
        type=int,
        default=8192,
        help="每张图最多保留的 SIFT 特征数，默认 8192",
    )
    prepare_video.add_argument(
        "--affine-shape",
        action="store_true",
        help="启用 SIFT 仿射形状估计；更慢且更耗内存，斜视墙面较多时可尝试",
    )
    prepare_video.add_argument(
        "--domain-size-pooling",
        action="store_true",
        help="启用 SIFT Domain-Size Pooling；更慢且更耗内存",
    )
    prepare_video.add_argument(
        "--overlap",
        type=int,
        default=20,
        help="每帧向前后进行顺序匹配的邻帧数，默认 20",
    )
    prepare_video.add_argument(
        "--no-quadratic-overlap",
        action="store_false",
        dest="quadratic_overlap",
        help="关闭 1、2、4、8…间隔的二次重叠匹配（默认启用）",
    )
    prepare_video.add_argument(
        "--max-threads",
        type=int,
        default=None,
        help=(
            "限制 COLMAP 特征提取、匹配、回环检索和 mapper 的线程数；"
            "默认沿用 COLMAP 自动值"
        ),
    )
    prepare_video.add_argument(
        "--loop-detection",
        action="store_true",
        help="启用视频回环检测；必须同时用 --vocab-tree 指定本地词汇树文件",
    )
    prepare_video.add_argument(
        "--vocab-tree",
        metavar="PATH",
        help="回环检测使用的本地 vocabulary tree；仅只读校验和传给 COLMAP",
    )
    prepare_video.add_argument(
        "--quality-threshold",
        type=float,
        default=85.0,
        help="最佳连通模型最低注册率百分比，默认 85；未达标返回 3 但保留结果",
    )
    prepare_video.add_argument(
        "--min-images",
        type=int,
        default=20,
        help="开始重建所需的最少图像数，默认 20",
    )
    prepare_video.add_argument(
        "--allow-existing",
        action="store_true",
        help="允许 COLMAP 使用已有 database/sparse；工具自身不会删除任何文件",
    )
    prepare_video.set_defaults(
        handler=command_prepare_video,
        quadratic_overlap=True,
    )

    cpu_reconstruct = subparsers.add_parser(
        "cpu-reconstruct",
        help="用 COLMAP + OpenMVS 的稳定 CPU 流程生成纹理网格 GLB",
    )
    add_project_arguments(cpu_reconstruct)
    cpu_reconstruct.add_argument(
        "--colmap", help="COLMAP.bat 或 bin\\colmap.exe 的路径"
    )
    cpu_reconstruct.add_argument(
        "--openmvs", help="OpenMVS Release 目录；也可设置 OPENMVS_DIR"
    )
    cpu_reconstruct.add_argument(
        "--model-index",
        type=int,
        help="指定 sparse 下的模型编号；默认选择注册图像最多的连通模型",
    )
    cpu_reconstruct.add_argument(
        "--preset",
        choices=tuple(CPU_RECONSTRUCTION_PRESETS),
        default="standard",
        help="CPU 重建参数预设；standard 保持原默认，high 适合 4K 手机素材",
    )
    cpu_reconstruct.add_argument(
        "--max-resolution",
        type=int,
        default=None,
        help="覆盖预设的去畸变/稠密重建最大分辨率",
    )
    cpu_reconstruct.add_argument(
        "--min-resolution",
        type=int,
        default=None,
        help="覆盖预设的 OpenMVS 稠密重建最小分辨率",
    )
    cpu_reconstruct.add_argument(
        "--max-threads",
        type=int,
        default=None,
        help="覆盖预设的最大 CPU 线程数；standard 默认使用全部逻辑处理器",
    )
    cpu_reconstruct.add_argument(
        "--allow-existing",
        action="store_true",
        help=(
            "允许在已有 openmvs 目录中重算同名阶段；"
            "不会自动验证中断产物，也不会主动删除旧文件"
        ),
    )
    cpu_reconstruct.set_defaults(handler=command_cpu_reconstruct)

    train = subparsers.add_parser("train", help="调用 Brush 训练并导出 Gaussian Splat PLY")
    add_project_arguments(train)
    train.add_argument("--brush", help="Brush 可执行文件路径（如 brush.exe）")
    train.add_argument(
        "--iterations", type=int, default=30000, help="Brush 训练迭代数，默认 30000"
    )
    train.add_argument(
        "--max-resolution", type=int, default=1920, help="Brush 训练图像最大分辨率"
    )
    train.add_argument(
        "--brush-profile",
        choices=("auto", "v0.3", "main"),
        default=os.environ.get("BRUSH_PROFILE", "auto"),
        help="CLI 参数档位；auto 会读取 brush --help，正式版 v0.3 使用 --total-steps",
    )
    train.add_argument("--ply-name", help="输出 PLY 文件名，默认 <项目名>.ply")
    train.add_argument(
        "--brush-template",
        help="Brush 参数模板（JSON 字符串数组）；优先建议使用模板文件",
    )
    train.add_argument(
        "--brush-template-file",
        help="UTF-8 JSON 参数模板文件，详见 scanner/README.md",
    )
    train.add_argument(
        "--allow-existing",
        action="store_true",
        help="允许目标 PLY 已存在；本工具不会主动删除文件",
    )
    train.set_defaults(handler=command_train)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except RoomScanError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n已由用户中止；没有执行后续步骤。", file=sys.stderr)
        return 130
    except OSError as error:
        print(f"错误：文件系统操作失败：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
