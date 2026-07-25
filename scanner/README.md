# 扫描与三维重建工具

`room_scan.py` 是独立于 Web 应用的本地命令行工具，用于从摄像头或视频采集有序图像，并衔接 COLMAP、Brush 和 OpenMVS 完成三维重建。

仓库不包含真实扫描素材、相机视频、重建数据库或训练产物。默认工作目录 `scanner/datasets/` 已被 `.gitignore` 排除，避免把室内影像、绝对路径元数据和大体积模型提交到 Git。

## 功能概览

| 命令 | 用途 | 主要外部依赖 |
| --- | --- | --- |
| `doctor` | 检查 Python 与重建工具是否可用 | OpenCV、COLMAP、Brush；OpenMVS 可选 |
| `capture` | 从摄像头采集清晰、有序的图像帧 | OpenCV |
| `import-video` | 从本地视频按清晰度和画面变化筛选图像帧 | OpenCV |
| `prepare` | 使用 COLMAP 通用自动流程生成稀疏模型 | COLMAP |
| `prepare-video` | 使用面向有序视频的 COLMAP CPU 流程生成稀疏模型 | COLMAP |
| `audit-sparse` | 只读审计 COLMAP 连通模型的注册率与质量 | 无额外进程 |
| `train` | 使用 Brush 训练并导出 Gaussian Splat PLY | Brush |
| `cpu-reconstruct` | 使用 COLMAP 与 OpenMVS 生成稠密点云、网格和纹理 GLB | COLMAP、OpenMVS |

工具默认不会覆盖已有数据。支持写操作的命令均可先加 `--dry-run` 校验路径和参数；外部程序通过参数数组启动，不拼接 shell 命令。

## 安装 Python 环境

建议使用 Python 3.10 或更高版本。在仓库根目录执行：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r scanner\requirements.txt
```

macOS 或 Linux 可将 Python 路径替换为 `./.venv/bin/python`。

`scanner/requirements.txt` 只安装 Python 依赖：

- NumPy；
- OpenCV；
- SciPy。

虚拟环境 `.venv/` 和 `scanner/.venv/` 均已被 `.gitignore` 排除。不要提交虚拟环境、下载缓存或本机生成的锁定文件。

下面的 PowerShell 示例使用两个短变量，便于复制：

```powershell
$Python = ".\.venv\Scripts\python.exe"
$Scanner = "scanner\room_scan.py"
```

## 安装外部重建工具

COLMAP、Brush 与 OpenMVS 不会随本仓库分发，也不由 `requirements.txt` 安装。请从各项目的官方发布页获取与操作系统匹配的版本，并自行核对许可证和硬件要求。

工具会优先检查以下本地目录；整个 `.tools/` 已被 `.gitignore` 排除：

```text
.tools/
  colmap/bin/colmap.exe
  brush/brush_app.exe
  openmvs/<release-directory>/
```

也可以通过命令参数或环境变量指定安装位置：

| 工具 | 命令参数 | 环境变量 |
| --- | --- | --- |
| COLMAP | `--colmap` | `COLMAP_EXE` |
| Brush | `--brush` | `BRUSH_EXE` |
| OpenMVS | `--openmvs` | `OPENMVS_DIR` |

OpenMVS 的 Release 目录需要同时包含：

- `InterfaceCOLMAP`；
- `DensifyPointCloud`；
- `ReconstructMesh`；
- `TextureMesh`。

先运行环境检查：

```powershell
& $Python $Scanner doctor
```

缺少 OpenMVS 只会影响 `cpu-reconstruct`；缺少其他必需工具时，`doctor` 会返回非零退出码。

## 快速工作流

以下示例使用虚构的数据集名 `demo-scan`。项目名必须是安全的单一路径组件，不能包含路径穿越、斜杠或系统保留名称。

### 1. 摄像头采集

先检查执行计划：

```powershell
& $Python $Scanner capture demo-scan --dry-run
```

开始采集：

```powershell
& $Python $Scanner capture demo-scan `
  --camera 0 `
  --width 1920 `
  --height 1080 `
  --interval 0.45 `
  --sharpness 10 `
  --max-frames 600
```

采集窗口中：

- `空格`：开始或暂停；
- `S`：立即尝试保存当前帧；
- `Q` 或 `Esc`：安全退出。

首次使用前请在操作系统中允许桌面应用访问摄像头，并关闭其他正在占用摄像头的软件。

拍摄时尽量保持稳定曝光，让相邻帧有充分重叠，并避开快速转身、反光表面、动态人群和大面积无纹理区域。采集他人或非公开空间前，应先取得授权。

### 2. 从本地视频筛选帧

可将仅供本机使用的视频放到已忽略的 `scanner/datasets/` 下，再执行：

```powershell
& $Python $Scanner import-video demo-scan `
  "scanner\datasets\input-video.mp4" `
  --target-fps 2.5 `
  --sharpness 10 `
  --motion-threshold 1.5 `
  --max-frames 800 `
  --dry-run
```

确认无误后移除 `--dry-run`。命令只读源视频，不会修改或复制它；筛选结果会写入数据集的 `images/`。导入清单可能记录源文件路径和媒体属性，因此也必须留在被忽略的数据目录中。

若目标 `images/` 非空，命令默认拒绝继续。只有在明确需要追加且已备份时才使用 `--allow-existing`。

### 3. 生成并审计稀疏模型

有序视频优先使用：

```powershell
& $Python $Scanner prepare-video demo-scan --dry-run
& $Python $Scanner prepare-video demo-scan
& $Python $Scanner audit-sparse demo-scan
```

一般图像集也可使用 COLMAP 的自动重建：

```powershell
& $Python $Scanner prepare demo-scan --quality MEDIUM --dry-run
& $Python $Scanner prepare demo-scan --quality MEDIUM
```

`prepare-video` 默认使用 CPU SIFT、顺序匹配和最佳连通模型注册率门槛。素材存在闭环轨迹时，可以额外提供本地 vocabulary tree：

```powershell
& $Python $Scanner prepare-video demo-scan `
  --loop-detection `
  --vocab-tree "<本地词汇树文件>"
```

词汇树只会被读取，不会复制进数据集。高分辨率、仿射形状和 Domain-Size Pooling 会明显增加运行时间与内存占用，请逐项启用并观察资源使用情况。

### 4. 生成 Gaussian Splat

```powershell
& $Python $Scanner train demo-scan --iterations 30000 --dry-run
& $Python $Scanner train demo-scan --iterations 30000
```

默认输出位于：

```text
scanner/datasets/demo-scan/brush/demo-scan.ply
```

Brush 不同版本的参数可能不同。先运行对应二进制文件的 `--help`；必要时使用 `--brush-profile`，或通过 `--brush-template-file` 提供 UTF-8 JSON 参数数组。模板是参数数组，不是 shell 命令。

### 5. 生成 CPU 纹理网格

```powershell
& $Python $Scanner cpu-reconstruct demo-scan --preset standard --dry-run
& $Python $Scanner cpu-reconstruct demo-scan --preset standard
```

该流程会选择注册图像最多的 COLMAP 连通模型，再依次运行 OpenMVS 的转换、稠密化、网格重建和纹理阶段。输出通常位于数据集的 `openmvs/` 目录。

CPU 稠密重建可能耗时较长并占用大量内存。先使用默认分辨率；需要降载时再调整 `--max-resolution` 和 `--max-threads`。

## 数据目录

默认结构如下：

```text
scanner/datasets/
  <project>/
    images/
    video-import-manifest.json
    database.db
    sparse/
      0/
    brush/
      <project>.ply
    openmvs/
      scene_cpu_dense.ply
      scene_cpu_mesh.ply
      <project>-textured-embedded.glb
```

可通过 `--dataset-root` 或 `ROOM_SCAN_DATA_ROOT` 把数据集放到仓库外的专用磁盘。完整的数据管理、备份和隐私建议见 [DATASETS.md](DATASETS.md)。

仓库中的 `public/models/room-01/demo-room*.ply` 是为界面演示生成的合成资产，与任何本地扫描数据集无关。

## 测试

单元测试不需要摄像头、COLMAP、Brush 或 OpenMVS：

```powershell
& $Python -B -m unittest discover -s scanner\tests -v
```

测试覆盖路径边界、输入保护、视频筛选、原子写入、COLMAP/OpenMVS 参数、Brush 模板和 `--dry-run` 行为。

## 常见问题

- 摄像头无法打开：检查系统隐私权限、设备编号和其他占用程序，再尝试不同 OpenCV 后端。
- 视频无法解码：确认源文件已完整下载，并检查当前 OpenCV 构建是否支持视频编码。
- 合格帧过少：逐步降低 `--sharpness` 或 `--motion-threshold`，不要直接导入全部近重复帧。
- COLMAP 注册率低：增加相邻帧重叠，减少运动模糊、反射和无纹理画面。
- 外部工具缺少动态库：确认命令指向完整的官方解压目录，不要只复制单个可执行文件。
- 已存在输出：先备份整个数据集；只有确认要复用中间结果时才使用 `--allow-existing`。

## 隐私与开源边界

- 不要提交室内照片、人物影像、原始视频、相机标定隐私信息或重建模型。
- 不要把真实文件路径、设备序列号、地理位置或访问凭据写入文档和示例。
- 发布模型前应检查纹理和点云中是否能识别人脸、屏幕、门牌、二维码或私人空间。
- 大型数据集应存放在访问受控的外部存储中，并使用独立备份策略；Git LFS 也不能替代隐私审查。
