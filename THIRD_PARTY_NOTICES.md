# 第三方组件与可选资产

本项目通过 `package.json`、`package-lock.json`、`scanner/requirements.txt` 和 `jetson/requirements.txt` 引用开源依赖。各组件仍受其原始许可证和版权声明约束；发布或再分发前，请根据实际使用的依赖完成许可证合规检查。

以下内容不随仓库分发：

- NVIDIA JetPack 中的平台版 PyTorch 与 OpenCV；
- 海康机器人 MVS SDK 及其 Python 绑定；
- Ultralytics/YOLO 模型权重（例如 `fire.pt`）；
- COLMAP、Brush、OpenMVS 等外部重建工具；
- DeepSeek、阿里云百炼/通义、华为云 IoTDA 等第三方服务的账号或凭据；
- 真实场地照片、点云、遥测、移动端安装包和设备固件成品。

使用者需要自行取得这些服务、SDK、模型或素材的合法授权，并遵守其许可、隐私和出口管制要求。本项目与上述厂商不存在官方隶属或背书关系。

仓库内的演示房间点云、项目标识和界面示意图为项目自制的合成素材，仅用于说明功能。
