# Jetson 小车控制协议

`vehicle_server.py` 保留现有长按遥控协议，并新增两种在 Jetson 本机执行的闭环 PID 任务。所有消息均为 WebSocket JSON。

## 原有手动控制（保持兼容）

```json
{"cmd":"move","speeds":[80,-80,80,-80]}
{"cmd":"stop"}
{"cmd":"forward"}
{"cmd":"back"}
{"cmd":"left"}
{"cmd":"right"}
```

`move` 仍用于网页长按遥控；松开按键发送 `stop`。任何手动移动、方向或停止命令都会先取消正在运行的闭环任务，避免两套控制器同时写电机。

## Jetson 本地航向归零

```json
{"cmd":"imu_zero","request_id":"imu-zero-test-001"}
```

网页不再维护航向偏移，只发送一次带 `request_id` 的归零请求。Jetson 会先停车并取消可能存在的距离或转向 PID 任务；仅当 MPU6050 已完成校准、车辆静止且当前角速度为零时，才把本机累计的 `yaw_total_deg` 设为 `0`。归零成功后，V2 IMU 回传中的 `zero_revision` 加一，车辆页与空间孪生据此采用同一份新航向基准。

Jetson 终端依次输出 `[IMU ZERO] received` 和 `[IMU ZERO] applied`；安全条件不满足时输出 `[IMU ZERO] rejected` 及原因。网页在 `zero_revision` 变化后显示设备确认，3 秒未变化则提示检查上述日志。

## 按距离移动

```json
{
  "cmd": "move_distance",
  "request_id": "distance-test-001",
  "direction": "forward",
  "distance_mm": 500,
  "max_speed_mmps": 80,
  "timeout_s": 20
}
```

- `direction`：`forward` 或 `backward`，默认 `forward`
- `distance_mm`：50–1500，必填
- `max_speed_mmps`：30–300，默认 80
- `timeout_s`：1–30，可省略，由距离和最大轮速计算

距离由 `$MSPD` 四轮速度在 Jetson 本机按真实单调时间积分。轮速反馈超过 500 ms 未更新时立即停车并返回失败。

## 按角度转向

```json
{
  "cmd": "turn_angle",
  "request_id": "turn-test-001",
  "direction": "left",
  "angle_deg": 90,
  "max_speed_mmps": 70,
  "timeout_s": 15
}
```

- `direction`：`left` 或 `right`，默认 `left`
- `angle_deg`：5–180，必填
- `max_speed_mmps`：30–300，默认 75
- `timeout_s`：1–30，可省略

角度只以 Jetson 本地积分得到的 MPU6050 `yaw_total_deg` 为反馈，不使用网页原始 `gz` 积分或轮速估算航向。IMU 必须已完成静止校准；反馈超过 250 ms 未更新时立即停车并返回失败。

## 控制状态回执

Jetson 向所有已连接控制端广播：

```json
{
  "type": "control",
  "version": 1,
  "request_id": "distance-test-001",
  "kind": "distance",
  "state": "running",
  "target_distance_mm": 500,
  "measured_distance_mm": 318.4,
  "error_mm": 181.6,
  "output_speed_mmps": 80,
  "elapsed_ms": 4200,
  "ts": 1784690000.0
}
```

`state` 可能为 `started`、`running`、`completed`、`failed`、`cancelled` 或 `stopped`。只有 `completed` 可视为设备端闭环完成；发送成功或 `started` 都不代表已经到达目标。

## 固定地图自动巡航

自动巡航由 `navigation_planner.py` 和 `vehicle_server.py` 在 Jetson 本机完成。网页/Android 只上传手动画出的固定墙线、请求规划并在用户再次确认后启动。系统不会识别临时障碍或移动物体。

部署时把以下文件放在同一目录：

```text
vehicle_server.py
navigation_planner.py
requirements.txt
```

导航模块只使用 Python 标准库，不需要新增 pip 包。保留 Jetson 当前 JetPack、PyTorch、OpenCV、MVS 相机 SDK、串口与 I²C 环境，不要使用通用 pip wheel 覆盖这些平台组件。地图会保存为同目录的 `navigation_map.json`；Jetson 重启后只恢复地图并保持停车，不恢复旧任务。启动入口仍是 `python3 vehicle_server.py`，`navigation_planner.py` 由服务自动导入，不需要单独运行。

导航命令：

```json
{"cmd":"navigation_map_get","request_id":"map-get-1"}
{"cmd":"navigation_map_set","request_id":"map-set-1","base_revision":0,"map":{"version":1,"map_id":"room-01","revision":1,"width_m":4.0,"height_m":5.0,"resolution_m":0.05,"vehicle":{"length_m":0.0,"width_m":0.0,"clearance_m":0.0},"strokes":[]}}
{"cmd":"navigation_plan","request_id":"plan-1","map_revision":1,"start":{"x":0.2,"y":0.3,"heading_deg":0},"goal":{"x":0.7,"y":0.8}}
{"cmd":"navigation_start","request_id":"start-1","task_id":"navigation-..."}
{"cmd":"navigation_cancel","request_id":"cancel-1","task_id":"navigation-..."}
{"cmd":"navigation_status","request_id":"status-1"}
```

坐标均归一化到 `0–1`；地图外沿始终是墙。规划器采用 5cm 栅格、约 17.5cm 圆形安全包络和禁止斜向穿角的八邻域 A*，路线最长 10m。执行器按“原地转向 + 最长 1.5m 直线段”运行，每到达一个巡航点就从 Jetson 当前估算位姿重新规划剩余路线。转向使用 Jetson 本地 MPU6050 累计航向，直线距离使用四轮反馈；所有 PID 有效速度下限为 30mm/s，直线最高 300mm/s，最终 20cm 降至 30mm/s，转向 PID 的 `Kp` 为 0.8。单次转向或直线 PID 调整最多等待 20 秒，任务最长 3 分钟且重规划不会重置这个总上限。

YOLO 检测结果随里程计 WebSocket 上报，火焰状态位于 `data.fire_detected`。该字段只取布尔值：当前推理帧检测到火焰为 `true`，否则为 `false`；不上传检测框、类别列表或置信度。

自动巡航单独采用距离 `30/60mm`、航向 `3/4°` 的进入/释放滞回容差，稳定约 200ms 即接受，不改变独立的定距与定角 PID。转向或直线调整超时后先 PWM 停车，等待轮速与 IMU 稳定，再从当前位置恢复规划；同一区域连续恢复最多 3 次，单次任务累计恢复最多 8 次。完全没有运动反馈、反馈过期、持续运动、越界或重新规划不可达仍然立即停车并终止任务。

Jetson 回传 `type: "navigation", version: 1`，状态包括 `map-ready`、`planning`、`planned`、`running`、`completed`、`failed`、`cancelled`、`stopped`。运行回传包含路径、Jetson 估算位姿、路段、剩余距离和用时；`phase: "replanning"` 以及 `path_revision`、`replan_count`、`recovery_replan_count`、`replan_reason` 用于让网页实时替换路线并显示恢复过程。网页断线不会终止已启动任务；重新连接后使用 `navigation_status` 恢复显示。任何手动移动、归零、取消或停止命令都会终止自动任务并停车。

IMU/轮速过期、完全无运动反馈、越界、修订冲突、超长路线或超过 1MB 的命令都会被拒绝或立即停车；调整超时只在反馈仍可靠且车辆可确认停稳时进入有界恢复重规划。首次真车验证应在空旷区域由操作者点击开始，先用约 0.5m 的短路线并全程准备急停。

## 首次实车测试

1. 架空车轮并准备物理急停。
2. 等待轮速回传稳定、IMU 完成静止校准。
3. 先测试 `move_distance`：50 mm、`max_speed_mmps` 75。
4. 再测试 `turn_angle`：5°、`max_speed_mmps` 75。
5. 核对方向和反馈符号；若实际方向相反，先修正电机或 IMU 符号，不要用负 PID 参数补偿。

测试客户端默认只打印命令，不会运动：

```bash
python3 pid_test_client.py --url ws://JETSON-IP:8765 distance
python3 pid_test_client.py --url ws://JETSON-IP:8765 turn
```

确认安全条件后才加 `--execute`：

```bash
python3 pid_test_client.py --url ws://JETSON-IP:8765 --execute distance --direction forward --distance-mm 50 --max-speed-mmps 75
python3 pid_test_client.py --url ws://JETSON-IP:8765 --execute turn --direction left --angle-deg 5 --max-speed-mmps 75
```
