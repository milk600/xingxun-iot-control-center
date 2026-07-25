# Jetson 车辆服务部署

`vehicle_server.py` 在 Jetson 上提供相机画面、火焰检测、里程计、IMU、闭环移动和导航 WebSocket 服务；`navigation_planner.py` 提供纯 Python 路径规划逻辑。

这是一套需要真实硬件的参考实现，不是即装即用的通用车辆固件。部署者必须根据自己的 Jetson、相机、串口控制器、IMU、模型和安全规范完成适配与验证。

## 开源边界

仓库包含：

- `vehicle_server.py`；
- `navigation_planner.py`；
- `pid_test_client.py`；
- 单元测试；
- `requirements.txt`。

仓库不包含：

- NVIDIA JetPack、CUDA、平台版 PyTorch 或 OpenCV；
- 海康机器人 MVS SDK 及其 Python 模块；
- 火焰检测权重 `fire.pt`；
- 真实导航地图、相机配置、设备序列号或标定数据；
- 云凭据、网络凭据或系统服务配置。

请在独立部署目录中提供模型和设备配置，不要把它们复制进 Git 工作树。发布自行训练的权重或采集数据前，应核对数据授权与第三方许可证。

## 平台依赖

先安装与 Jetson 型号和 JetPack 版本兼容的：

- Python 3；
- NVIDIA 提供或明确兼容的 PyTorch；
- 支持硬件的 OpenCV；
- 海康 MVS SDK；
- 相机驱动、串口和 I2C 系统权限。

确认平台模块可以导入：

```bash
python3 -c "import torch, cv2; print(torch.__version__, cv2.__version__)"
```

再在部署目录创建复用系统平台包的虚拟环境：

```bash
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

`requirements.txt` 只声明可移植的直接依赖：NumPy、pyserial、smbus2、Ultralytics 和 websockets。PyTorch、OpenCV、MVS SDK 与 `fire.pt` 故意不在其中。

安装前检查 pip 的解析计划。如果它准备使用通用 wheel 替换 JetPack 提供的 PyTorch、OpenCV 或 NumPy，请停止安装，按当前 JetPack 的兼容矩阵调整版本。升级平台组件后应重新执行完整硬件测试。

## 部署前适配

当前参考实现包含与硬件相关的默认值。启动前至少检查：

- `MODEL_PATH` 指向部署目录中的合法 `fire.pt`；
- MVS Python 模块能够被当前解释器发现；
- 串口设备、波特率和电机控制协议与控制器一致；
- I2C 总线和 MPU6050 地址与接线一致；
- 相机分辨率、帧率和像素格式受设备支持；
- 电机方向、轮径、死区和编码器反馈已经在本车标定；
- WebSocket 监听范围符合网络隔离策略；
- 导航地图的尺寸、坐标系和版本与客户端一致。

不要在带载或靠近人员、易燃物、台阶的环境中做首次适配。

## 启动

在部署目录中运行：

```bash
source .venv/bin/activate
python3 vehicle_server.py
```

服务默认监听 8765 端口。参考实现本身没有提供互联网级的身份验证或 TLS，严禁将该端口直接暴露到公网。应使用隔离局域网、防火墙和受信任客户端；跨网络部署需要在外层增加 TLS、身份验证、速率限制和审计。

`navigation_map.json` 会在收到地图配置后写入部署目录。它属于设备运行数据，不应提交到公开仓库。

## 首次验证

按以下顺序验证，并全程安排人员握住物理急停：

1. 断开电机动力或架空驱动轮，确认启动后 PWM 为零；
2. 检查串口、IMU、编码器和相机日志；
3. 确认 `fire.pt` 加载成功，且检测类别符合预期；
4. 从同机回环地址连接 WebSocket，检查只读遥测；
5. 验证停车指令；
6. 在轮子架空状态下用最低速度测试单轮方向和闭环反馈；
7. 在封闭空旷区域进行极短距离、极小角度测试；
8. 最后再验证地图边界、失联、超时和导航取消。

测试客户端默认只打印移动命令，不会发送：

```bash
python3 pid_test_client.py distance --distance-mm 50
python3 pid_test_client.py turn --angle-deg 5
```

只有确认车轮架空且物理急停可用时，才添加 `--execute`：

```bash
python3 pid_test_client.py --execute distance --distance-mm 50
```

停车命令不要求 `--execute`，会立即尝试发送：

```bash
python3 pid_test_client.py stop
```

## 安全停机

停止服务前：

1. 先通过受信任客户端发送 `stop`；
2. 等待状态回执并目视确认全部车轮静止；
3. 必要时使用物理急停切断执行器动力；
4. 再终止 Python 进程；
5. 最后检查串口控制器没有保持旧 PWM。

不要把 `Ctrl+C`、WebSocket 断开或 Python 的清理代码视为唯一停车保障。生产车辆必须具备控制器侧 watchdog、通信超时自动归零、独立硬件急停和上电不动作策略。

若出现无反馈、方向错误、超时、相机异常、IMU 漂移、地图越界或无法确认车辆状态，应立即物理急停，并在断开动力后排查。

## 作为系统服务运行

完成全部人工验证后，才考虑配置系统服务。服务配置至少应：

- 使用非特权专用账号；
- 仅授予必需的串口、I2C、相机和模型读取权限；
- 限制网络监听与文件写入目录；
- 启动失败时保持电机输出为零；
- 重启前执行受验证的停车路径；
- 将日志写入受控位置，并避免记录敏感网络信息；
- 避免无限快速重启。

系统服务文件通常包含机器专用路径和权限，不在本仓库提供。

## 测试

不连接真实硬件时，可以运行规划器和协议层单元测试：

```bash
python3 -m unittest discover -s . -p "test_*.py" -v
```

单元测试不能验证电机方向、制动距离、串口时延、摄像头驱动、模型准确率或硬件急停；这些都必须在目标设备上单独验收。
