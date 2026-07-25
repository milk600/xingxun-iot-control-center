# 扫描数据管理

`scanner/datasets/` 是扫描器默认的本地工作区，已被仓库根目录的 `.gitignore` 整体排除。这里可能包含室内影像、视频来源路径、COLMAP 数据库、相机参数、点云、纹理和大型模型，不应进入公开仓库。

本文只定义通用的数据组织和维护方式，不记录任何真实数据集、房间、设备或个人信息。

## 推荐结构

```text
scanner/datasets/
  <project>/
    images/
    video-import-manifest.json
    database.db
    database.db-wal
    database.db-shm
    sparse/
      0/
    brush/
      <project>.ply
    openmvs/
      scene_cpu_dense.ply
      scene_cpu_mesh.ply
      <project>-textured-embedded.glb
  _archive/
    <category>/
      <project>/
```

每个项目目录应作为一个整体管理。不要单独移动数据库、`sparse/` 或 `openmvs/` 的一部分，否则内部路径和阶段依赖可能失效。

## 命名建议

- 使用简短的技术名称，例如 `lab-demo-001`；
- 不使用姓名、账号、详细地点、门牌、资产编号或其他个人信息；
- 不包含空路径组件、`..`、斜杠或系统保留名称；
- 同一次采集使用固定名称；新一轮采集创建新项目，不覆盖旧结果。

## 存储位置

默认数据目录适合小规模开发。大型项目建议放到仓库外的专用磁盘：

```powershell
$env:ROOM_SCAN_DATA_ROOT = "<本地数据目录>"
```

也可对单次命令使用：

```powershell
py -3 scanner\room_scan.py audit-sparse demo-scan `
  --dataset-root "<本地数据目录>"
```

不要把外部数据目录放进 Git 工作树。即使使用 Git LFS，大型二进制文件和私人影像仍会进入远端历史，并不适合作为默认发布方式。

## 生命周期

### 创建

使用 `capture` 或 `import-video` 建立项目。先运行 `--dry-run`，确认项目名和目标根目录。

### 处理

稀疏重建、Gaussian Splat 和 OpenMVS 阶段均写入同一个项目目录。执行长任务时避免同步、移动或备份正在变化的文件。

### 审计

处理完成后记录软件版本、采集方式和可复现参数，但不要把源媒体绝对路径、设备标识或访问凭据复制到公开文档。可使用：

```powershell
py -3 scanner\room_scan.py audit-sparse demo-scan
```

### 归档

停止所有 COLMAP、OpenMVS、Brush 和 Python 进程后，再把整个项目移入 `_archive/<category>/`。恢复时也应移动整个项目目录，并确保目标名称尚不存在。

### 删除

删除前至少确认：

- 不再有进程打开该目录；
- 备份可读取且校验通过；
- Web 或移动端没有通过复制、链接或脚本引用该产物；
- 数据保留政策允许删除。

## 备份与完整性

- 对原始图像、数据库和最终产物分别建立版本化备份；
- 数据库运行期间可能出现 `-wal` 和 `-shm` 文件，备份前应停止写入进程；
- 使用文件大小、哈希或备份软件的校验功能验证复制结果；
- 至少保留一份与工作磁盘物理隔离的备份；
- 模型训练输出可以重建，但原始采集素材通常不可恢复。

## 隐私检查

扫描数据可能暴露人脸、屏幕内容、窗外位置、门牌、二维码、无线设备标签或私人物品。共享任何图像、纹理、点云或网格前，应进行人工检查和必要的裁剪、模糊或匿名化。

`video-import-manifest.json` 可能包含本地源文件路径和媒体属性，也应视为私人数据。不要仅检查图片扩展名。

仓库公开提供的 `public/models/room-01/demo-room*.ply` 是确定性生成的合成演示资产，不是任何真实数据集的备份或软链接。

## 提交前检查

在准备 Git 提交时，至少确认：

```powershell
git status --short --ignored
git check-ignore scanner\datasets
```

如需要共享可复现示例，应生成不含真实环境信息的微型合成数据，并在文档中明确标注为合成资产。不要从私人数据集中抽取“看起来匿名”的片段直接发布。
