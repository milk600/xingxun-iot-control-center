import asyncio
import json
import serial
import time
import websockets
import base64
import math
from collections import deque

import cv2
import numpy as np
import sys
from ctypes import *
from threading import Thread, Lock, Event

# ========= YOLO 火和烟检测相关 =========
import os
os.environ["YOLO_AUTOINSTALL"] = "False"
from ultralytics import YOLO
import torch

# ========= MPU6050 (I2C) 相关 =========
from smbus2 import SMBus

from navigation_planner import (
    GOAL_TOLERANCE_M,
    NavigationPlanError,
    integrate_normalized_pose,
    navigation_speed_limit_mmps,
    plan_path,
    shortest_heading_delta,
    slew_limited_drive_output,
    split_path_segments,
    validate_map_definition,
    within_goal_tolerance,
)

# 模型配置
MODEL_PATH = r"./fire.pt"
device = 0 if torch.cuda.is_available() else "cpu"
print("YOLO 运行设备：", "GPU" if device == 0 else "CPU")
model = YOLO(MODEL_PATH, task="detect")
print("YOLO 模型加载完成，识别类别：", model.names)

# ========= 相机参数 & MVS SDK =========
CAP_WIDTH  = 1440
CAP_HEIGHT = 1080
CAP_FPS    = 180

sys.path.append("/opt/MVS/Samples/aarch64/Python/MvImport")
from MvCameraControl_class import *

# ========= 串口初始化 =========
ser = serial.Serial(
    port='/dev/ttyUSB0',
    baudrate=115200,
    parity=serial.PARITY_NONE,
    stopbits=serial.STOPBITS_ONE,
    bytesize=serial.EIGHTBITS,
    timeout=1
)

recv_buffer = ""

def send(data):
    ser.write(data.encode())
    time.sleep(0.01)

def receive():
    global recv_buffer
    if ser.in_waiting:
        recv_buffer += ser.read(ser.in_waiting).decode()
        msgs = recv_buffer.split("#")
        recv_buffer = msgs[-1]
        if len(msgs) > 1:
            return msgs[0] + "#"
    return None

def parse(data):
    data = data.strip()
    if data.startswith("$MSPD:"):
        vals = [float(v) if '.' in v else int(v) for v in data[6:-1].split(',')]
        return {"M1": vals[0], "M2": vals[1], "M3": vals[2], "M4": vals[3]}
    return None

def control_speed(m1, m2, m3, m4):
    send(f"$spd:{m1},{m2},{m3},{m4}#")

def control_pwm(m1, m2, m3, m4):
    send(f"$pwm:{m1},{m2},{m3},{m4}#")

class PIDController:
    """带积分限幅与微分低通的离散 PID。"""

    def __init__(self, kp, ki, kd, output_limit, integral_limit, derivative_alpha=0.25):
        self.kp = float(kp)
        self.ki = float(ki)
        self.kd = float(kd)
        self.output_limit = abs(float(output_limit))
        self.integral_limit = abs(float(integral_limit))
        self.derivative_alpha = min(1.0, max(0.0, float(derivative_alpha)))
        self.integral = 0.0
        self.previous_error = None
        self.filtered_derivative = 0.0

    def update(self, error, dt_s):
        if not math.isfinite(error) or not math.isfinite(dt_s) or dt_s <= 0.0:
            raise ValueError("PID 输入必须是有限值且 dt_s > 0")
        self.integral = max(
            -self.integral_limit,
            min(self.integral_limit, self.integral + error * dt_s),
        )
        raw_derivative = 0.0 if self.previous_error is None else (error - self.previous_error) / dt_s
        self.filtered_derivative += self.derivative_alpha * (raw_derivative - self.filtered_derivative)
        self.previous_error = error
        output = self.kp * error + self.ki * self.integral + self.kd * self.filtered_derivative
        return max(-self.output_limit, min(self.output_limit, output))

# ========= MPU6050 初始化与读取 =========
MPU_ADDR     = 0x68
MPU_BUS      = 7
PWR_MGMT_1   = 0x6B
SMPLRT_DIV   = 0x19
CONFIG        = 0x1A
ACCEL_XOUT_H = 0x3B
GYRO_XOUT_H  = 0x43
TEMP_OUT_H   = 0x41

IMU_SAMPLE_PERIOD_S = 0.02
IMU_MAX_INTEGRATION_GAP_S = 0.25
IMU_CALIBRATION_MIN_S = 2.5
IMU_CALIBRATION_MIN_SAMPLES = 24
IMU_STATIONARY_WHEEL_MMPS = 5.0
IMU_STATIONARY_ACCEL_TOLERANCE_G = 0.08
IMU_STATIONARY_GYRO_DPS = 5.0
IMU_STATIONARY_YAW_DEADBAND_DPS = 0.18
IMU_LIVE_BIAS_TIME_CONSTANT_S = 20.0
IMU_BOOT_ID = f"{int(time.time())}-{os.getpid()}"

mpu_bus = SMBus(MPU_BUS)
mpu_bus.write_byte_data(MPU_ADDR, PWR_MGMT_1, 0x00)
time.sleep(0.1)
# 44 Hz 数字低通、50 Hz 输出。积分仍使用每个样本的真实单调时间。
mpu_bus.write_byte_data(MPU_ADDR, CONFIG, 0x03)
mpu_bus.write_byte_data(MPU_ADDR, SMPLRT_DIV, 19)

latest_mpu = {
    "ax": 0.0, "ay": 0.0, "az": 0.0,
    "gx": 0.0, "gy": 0.0, "gz": 0.0,
    "temp": 0.0,
    "yaw_total_deg": 0.0,
    "heading_deg": 0.0,
    "yaw_rate_dps": 0.0,
    "gyro_bias_z_dps": 0.0,
    "calibrated": False,
    "stationary": False,
    "calibration_samples": 0,
    "zero_revision": 0,
    "seq": 0,
    "sampled_at_ns": 0,
    "sampled_at_epoch_s": 0.0,
}
mpu_lock = Lock()
imu_zero_requested = Event()
imu_zero_request_id = None

latest_wheels = None
latest_wheels_sampled_at_ns = 0
odom_lock = Lock()

# ========= 闭环距离 / 航向控制 =========
PID_CONTROL_PERIOD_S = 0.02
PID_TELEMETRY_PERIOD_S = 0.10
PID_FEEDBACK_STARTUP_GRACE_S = 1.5
PID_WHEEL_FEEDBACK_TIMEOUT_S = 0.50
PID_IMU_FEEDBACK_TIMEOUT_S = 0.25
PID_DISTANCE_MIN_MM = 50.0
PID_DISTANCE_MAX_MM = 10000.0
PID_ANGLE_MIN_DEG = 5.0
PID_ANGLE_MAX_DEG = 720.0
PID_MAX_WHEEL_SPEED_MMPS = 300.0
PID_MIN_EFFECTIVE_SPEED_MMPS = 30.0
PID_TURN_KP = 0.80
PID_DISTANCE_TOLERANCE_MM = 10.0
PID_ANGLE_TOLERANCE_DEG = 2.0
PID_SETTLE_SAMPLES = 8
PID_MAX_TASK_DURATION_S = 180.0

closed_loop_task = None
closed_loop_owner = None
closed_loop_request_id = None
manual_motion_owner = None
manual_motion_request_id = None

# ========= 固定地图自动巡航 =========
NAVIGATION_MAP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "navigation_map.json")
NAVIGATION_MAX_RUNTIME_S = 180.0
NAVIGATION_MAX_ROUTE_M = 10.0
NAVIGATION_MAX_STRAIGHT_SPEED_MMPS = 300.0
NAVIGATION_TURN_SPEED_MMPS = 75.0
NAVIGATION_PID_WAIT_TIMEOUT_S = 20.0
NAVIGATION_MAX_SEGMENT_M = 1.5
NAVIGATION_NO_PROGRESS_TIMEOUT_S = 1.5
NAVIGATION_MAX_COMMAND_BYTES = 1_000_000
NAVIGATION_DISTANCE_TOLERANCE_MM = 30.0
NAVIGATION_DISTANCE_RELEASE_MM = 60.0
NAVIGATION_ANGLE_TOLERANCE_DEG = 3.0
NAVIGATION_ANGLE_RELEASE_DEG = 4.0
NAVIGATION_SETTLE_SAMPLES = 10
NAVIGATION_STATIONARY_WHEEL_MMPS = 10.0
NAVIGATION_STATIONARY_YAW_DPS = 1.5
NAVIGATION_REPLAN_SETTLE_S = 0.20
NAVIGATION_REPLAN_SETTLE_TIMEOUT_S = 1.5
NAVIGATION_MAX_CONSECUTIVE_RECOVERY_REPLANS = 3
NAVIGATION_MAX_RECOVERY_REPLANS = 8

navigation_map_definition = None
pending_navigation_plan = None
navigation_task = None
navigation_snapshot = None
navigation_cancel_state = "cancelled"
navigation_owner = None

def longitudinal_speed_mmps(wheels):
    """按当前电机安装极性，把四轮反馈合成为前进为正的纵向速度。"""
    return (
        float(wheels["M1"])
        - float(wheels["M2"])
        + float(wheels["M3"])
        - float(wheels["M4"])
    ) / 4.0

def bounded_pid_output(output, error, tolerance, maximum):
    if abs(error) <= tolerance:
        return 0.0
    limited = max(-maximum, min(maximum, output))
    if abs(limited) < PID_MIN_EFFECTIVE_SPEED_MMPS:
        return math.copysign(PID_MIN_EFFECTIVE_SPEED_MMPS, error)
    return limited

def navigation_tolerance_latched(error, latched, enter_tolerance, release_tolerance):
    """进入较紧容差后保持零输出，直到误差真正越出较宽容差。"""
    magnitude = abs(float(error))
    if latched:
        return magnitude <= float(release_tolerance)
    return magnitude <= float(enter_tolerance)

def drive_longitudinal(speed_mmps):
    speed = int(round(speed_mmps))
    control_speed(speed, -speed, speed, -speed)

def drive_turn(speed_mmps):
    """地图航向顺时针为正：正输出右转，负输出左转。"""
    speed = int(round(abs(speed_mmps)))
    if speed_mmps >= 0:
        control_speed(speed, speed, -speed, -speed)
    else:
        control_speed(-speed, -speed, speed, speed)

def read_mpu_word(bus, reg):
    high = bus.read_byte_data(MPU_ADDR, reg)
    low  = bus.read_byte_data(MPU_ADDR, reg + 1)
    val = (high << 8) | low
    return val - 65536 if val >= 0x8000 else val

def signed_word(data, index):
    value = (data[index] << 8) | data[index + 1]
    return value - 65536 if value >= 0x8000 else value

def trimmed_mean(values, trim_fraction=0.1):
    ordered = sorted(values)
    trim_count = int(len(ordered) * trim_fraction)
    retained = ordered[trim_count:len(ordered) - trim_count]
    return sum(retained) / len(retained)

def wheels_are_stationary(sampled_at_ns):
    with odom_lock:
        wheels = dict(latest_wheels) if latest_wheels is not None else None
        wheels_sampled_at_ns = latest_wheels_sampled_at_ns
    if wheels is None or sampled_at_ns - wheels_sampled_at_ns > 500_000_000:
        return False
    return all(abs(float(wheels[name])) <= IMU_STATIONARY_WHEEL_MMPS for name in ("M1", "M2", "M3", "M4"))

def mpu6050_loop():
    global latest_mpu, imu_zero_request_id
    gyro_window = deque(maxlen=3)
    calibration_samples = deque(maxlen=256)
    stationary_since_ns = None
    last_sampled_at_ns = None
    previous_yaw_rate_dps = 0.0
    gyro_bias_z_dps = 0.0
    yaw_total_deg = 0.0
    calibrated = False
    zero_revision = 0
    sequence = 0

    while True:
        loop_started = time.monotonic()
        try:
            # 一次突发读取保证加速度、温度和陀螺仪属于同一个硬件样本。
            raw = mpu_bus.read_i2c_block_data(MPU_ADDR, ACCEL_XOUT_H, 14)
            sampled_at_ns = time.monotonic_ns()
            sampled_at_epoch_s = time.time()

            ax = signed_word(raw, 0) / 16384.0
            ay = signed_word(raw, 2) / 16384.0
            az = signed_word(raw, 4) / 16384.0
            temp = signed_word(raw, 6) / 340.0 + 36.53
            gx = signed_word(raw, 8) / 131.0
            gy = signed_word(raw, 10) / 131.0
            gz = signed_word(raw, 12) / 131.0

            dt_s = None if last_sampled_at_ns is None else (sampled_at_ns - last_sampled_at_ns) / 1_000_000_000.0
            valid_dt = dt_s is not None and 0.0 < dt_s <= IMU_MAX_INTEGRATION_GAP_S
            accel_magnitude_g = math.sqrt(ax * ax + ay * ay + az * az)
            stationary = (
                wheels_are_stationary(sampled_at_ns)
                and abs(accel_magnitude_g - 1.0) <= IMU_STATIONARY_ACCEL_TOLERANCE_G
                and abs(gz) <= IMU_STATIONARY_GYRO_DPS
            )

            if stationary:
                if stationary_since_ns is None:
                    stationary_since_ns = sampled_at_ns
                if not calibrated:
                    calibration_samples.append(gz)
            else:
                stationary_since_ns = None
                if not calibrated:
                    calibration_samples.clear()

            gyro_window.append(gz)
            filtered_gz = sorted(gyro_window)[len(gyro_window) // 2]
            was_calibrated = calibrated
            calibration_elapsed_s = 0.0 if stationary_since_ns is None else (sampled_at_ns - stationary_since_ns) / 1_000_000_000.0

            if (
                not calibrated
                and stationary
                and calibration_elapsed_s >= IMU_CALIBRATION_MIN_S
                and len(calibration_samples) >= IMU_CALIBRATION_MIN_SAMPLES
            ):
                gyro_bias_z_dps = trimmed_mean(calibration_samples)
                calibrated = True
                yaw_total_deg = 0.0
                previous_yaw_rate_dps = 0.0
                zero_revision += 1
            elif calibrated and stationary and valid_dt:
                bias_alpha = dt_s / (IMU_LIVE_BIAS_TIME_CONSTANT_S + dt_s)
                gyro_bias_z_dps += bias_alpha * (gz - gyro_bias_z_dps)

            # +Z 朝上时正 gz 为逆时针；网页地图航向为顺时针，因此取反。
            yaw_rate_dps = -(filtered_gz - gyro_bias_z_dps) if calibrated else 0.0
            if stationary and abs(yaw_rate_dps) < IMU_STATIONARY_YAW_DEADBAND_DPS:
                yaw_rate_dps = 0.0

            zero_applied = False
            if imu_zero_requested.is_set():
                imu_zero_requested.clear()
                with mpu_lock:
                    zero_request_id = imu_zero_request_id
                    imu_zero_request_id = None
                if calibrated and stationary and yaw_rate_dps == 0.0:
                    yaw_total_deg = 0.0
                    previous_yaw_rate_dps = 0.0
                    zero_revision += 1
                    zero_applied = True
                    print(
                        f"[IMU ZERO] applied request_id={zero_request_id or 'unknown'} "
                        f"zero_revision={zero_revision}"
                    )
                else:
                    reasons = []
                    if not calibrated:
                        reasons.append("not_calibrated")
                    if not stationary:
                        reasons.append("vehicle_not_stationary")
                    if yaw_rate_dps != 0.0:
                        reasons.append(f"yaw_rate={yaw_rate_dps:.3f}dps")
                    print(
                        f"[IMU ZERO] rejected request_id={zero_request_id or 'unknown'} "
                        f"reason={','.join(reasons) or 'unsafe_state'}"
                    )

            # 积分完全在 Jetson 本地完成，不受 WebSocket、视频编码或浏览器调度影响。
            if was_calibrated and calibrated and valid_dt and not zero_applied:
                yaw_total_deg += (previous_yaw_rate_dps + yaw_rate_dps) * 0.5 * dt_s

            previous_yaw_rate_dps = yaw_rate_dps
            last_sampled_at_ns = sampled_at_ns
            sequence += 1

            with mpu_lock:
                latest_mpu = {
                    "ax": ax, "ay": ay, "az": az,
                    "gx": gx, "gy": gy, "gz": gz,
                    "temp": temp,
                    "yaw_total_deg": yaw_total_deg,
                    "heading_deg": yaw_total_deg % 360.0,
                    "yaw_rate_dps": yaw_rate_dps,
                    "gyro_bias_z_dps": gyro_bias_z_dps,
                    "calibrated": calibrated,
                    "stationary": stationary,
                    "calibration_samples": len(calibration_samples),
                    "zero_revision": zero_revision,
                    "seq": sequence,
                    "sampled_at_ns": sampled_at_ns,
                    "sampled_at_epoch_s": sampled_at_epoch_s,
                }
        except Exception as e:
            print("MPU6050 read error:", e)
        elapsed = time.monotonic() - loop_started
        time.sleep(max(0.001, IMU_SAMPLE_PERIOD_S - elapsed))

# ========= 相机初始化 =========
def decoding_char(arr):
    byte_str = memoryview(arr).tobytes()
    null_idx = byte_str.find(b'\x00')
    if null_idx != -1:
        byte_str = byte_str[:null_idx]
    for enc in ['gbk', 'utf-8', 'latin-1']:
        try:
            return byte_str.decode(enc)
        except:
            continue
    return byte_str.decode('latin-1', errors='replace')

MvCamera.MV_CC_Initialize()

dev_list = MV_CC_DEVICE_INFO_LIST()
ret = MvCamera.MV_CC_EnumDevices(MV_GIGE_DEVICE | MV_USB_DEVICE, dev_list)
if ret != 0 or dev_list.nDeviceNum == 0:
    print("未检测到相机")
    sys.exit(-1)

info = cast(dev_list.pDeviceInfo[0], POINTER(MV_CC_DEVICE_INFO)).contents
print("相机型号:", decoding_char(info.SpecialInfo.stUsb3VInfo.chModelName))

cam = MvCamera()
cam.MV_CC_CreateHandle(info)
cam.MV_CC_OpenDevice(MV_ACCESS_Exclusive, 0)

cam.MV_CC_SetIntValue("Width", CAP_WIDTH)
cam.MV_CC_SetIntValue("Height", CAP_HEIGHT)
cam.MV_CC_SetFloatValue("AcquisitionFrameRate", CAP_FPS)
cam.MV_CC_SetEnumValue("TriggerMode", MV_TRIGGER_MODE_OFF)

cam.MV_CC_StartGrabbing()
print("相机开始采集")

latest_frame = None
frame_lock = Lock()

latest_annotated = None
annotated_lock = Lock()

latest_fire_detected = False
fire_detection_lock = Lock()

def is_fire_class_label(value):
    """只把明确的火焰类别视为火焰，烟雾等其他类别不会触发上报。"""
    label = str(value).strip().lower()
    return (
        label in ("fire", "flame", "火焰")
        or "fire" in label
        or "flame" in label
        or "火焰" in label
    )

def yolo_result_has_fire(result, class_names):
    boxes = getattr(result, "boxes", None)
    classes = getattr(boxes, "cls", None)
    if classes is None:
        return False
    if hasattr(classes, "detach"):
        classes = classes.detach()
    if hasattr(classes, "cpu"):
        classes = classes.cpu()
    class_ids = classes.tolist() if hasattr(classes, "tolist") else list(classes)
    for class_id in class_ids:
        index = int(class_id)
        if isinstance(class_names, dict):
            label = class_names.get(index, "")
        elif isinstance(class_names, (list, tuple)) and 0 <= index < len(class_names):
            label = class_names[index]
        else:
            label = ""
        if is_fire_class_label(label):
            return True
    return False

def camera_grab_loop():
    global latest_frame
    stFrame = MV_FRAME_OUT()
    while True:
        ret = cam.MV_CC_GetImageBuffer(stFrame, 1000)
        if ret == 0 and stFrame.pBufAddr:
            bayer = np.frombuffer(
                string_at(stFrame.pBufAddr, stFrame.stFrameInfo.nFrameLen),
                dtype=np.uint8
            ).reshape(
                stFrame.stFrameInfo.nHeight,
                stFrame.stFrameInfo.nWidth
            )
            bgr = cv2.cvtColor(bayer, cv2.COLOR_BayerBG2BGR)
            bgr = cv2.resize(bgr, None, fx=0.5, fy=0.5)
            with frame_lock:
                latest_frame = bgr
            cam.MV_CC_FreeImageBuffer(stFrame)
        else:
            time.sleep(0.001)

def inference_loop():
    global latest_annotated, latest_fire_detected
    while True:
        with frame_lock:
            frame = latest_frame
        if frame is not None:
            results = model.predict(
                source=frame,
                imgsz=640,
                conf=0.25,
                device=device,
                verbose=False,
            )
            result = results[0]
            fire_detected = yolo_result_has_fire(result, model.names)
            annotated = result.plot()
            with fire_detection_lock:
                latest_fire_detected = fire_detected
            with annotated_lock:
                latest_annotated = annotated
        else:
            time.sleep(0.01)

# ========= WebSocket 客户端管理 =========
clients = set()
client_network_rtt_ms = {}

class ClosedLoopControlError(RuntimeError):
    pass

class NavigationReplanRequired(ClosedLoopControlError):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason

def finite_command_number(command, name, minimum, maximum, default=None):
    value = command.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ClosedLoopControlError(f"{name} 必须是有限数值")
    number = float(value)
    if number < minimum or number > maximum:
        raise ClosedLoopControlError(f"{name} 必须在 {minimum} 到 {maximum} 之间")
    return number

def command_request_id(command):
    request_id = command.get("request_id")
    if isinstance(request_id, str) and 1 <= len(request_id.strip()) <= 128:
        return request_id.strip()
    return f"jetson-control-{time.monotonic_ns()}"

def control_timeout_s(command, default_s):
    if "timeout_s" not in command:
        return min(PID_MAX_TASK_DURATION_S, max(2.0, default_s))
    return finite_command_number(command, "timeout_s", 1.0, PID_MAX_TASK_DURATION_S)

async def broadcast_control_status(state, request_id, kind, **details):
    if not clients:
        return
    message = json.dumps({
        "type": "control",
        "version": 1,
        "ts": time.time(),
        "request_id": request_id,
        "kind": kind,
        "state": state,
        **details,
    })
    await asyncio.gather(
        *(client.send(message) for client in tuple(clients)),
        return_exceptions=True,
    )


def load_navigation_map():
    try:
        with open(NAVIGATION_MAP_PATH, "r", encoding="utf-8") as handle:
            return validate_map_definition(json.load(handle))
    except FileNotFoundError:
        return None
    except Exception as error:
        print(f"[NAVIGATION] 忽略无效地图文件: {error}")
        return None


def persist_navigation_map(definition):
    temporary_path = f"{NAVIGATION_MAP_PATH}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as handle:
        json.dump(definition, handle, ensure_ascii=False, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_path, NAVIGATION_MAP_PATH)


async def send_navigation_payload(websocket, payload):
    await websocket.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


async def broadcast_navigation_status(state, request_id=None, **details):
    global navigation_snapshot
    payload = {
        "type": "navigation",
        "version": 1,
        "ts": time.time(),
        "state": state,
        **({"request_id": request_id} if request_id else {}),
        **details,
    }
    navigation_snapshot = payload
    if clients:
        message = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        await asyncio.gather(
            *(client.send(message) for client in tuple(clients)),
            return_exceptions=True,
        )
    return payload


async def send_current_navigation_status(websocket):
    if navigation_snapshot is not None:
        await send_navigation_payload(websocket, navigation_snapshot)
        return
    await send_navigation_payload(websocket, {
        "type": "navigation",
        "version": 1,
        "ts": time.time(),
        "state": "map-ready",
        "ready": navigation_map_definition is not None,
        "map": navigation_map_definition,
    })


def navigation_task_running():
    return navigation_task is not None and not navigation_task.done()


def navigation_pose_heading(plan):
    with mpu_lock:
        current_yaw_deg = float(latest_mpu.get("yaw_total_deg", plan["imu_start_yaw_deg"]))
    return (plan["start_heading_deg"] + current_yaw_deg - plan["imu_start_yaw_deg"]) % 360.0


def navigation_status_details(plan, *, phase, segment_index, remaining_distance_m, elapsed_ms, **details):
    return {
        "task_id": plan["task_id"],
        "map_revision": plan["map_revision"],
        "phase": phase,
        "path": plan["path"],
        "pose": dict(plan["pose"]),
        "distance_m": plan["distance_m"],
        "remaining_distance_m": max(0.0, remaining_distance_m),
        "estimated_seconds": plan["estimated_seconds"],
        "goal_tolerance_m": GOAL_TOLERANCE_M,
        "segment_index": segment_index,
        "segment_count": int(plan.get("completed_waypoints", 0)) + len(plan["segments"]),
        "elapsed_ms": max(0, int(elapsed_ms)),
        "max_speed_mmps": NAVIGATION_MAX_STRAIGHT_SPEED_MMPS,
        "path_revision": int(plan.get("path_revision", 1)),
        "replan_count": int(plan.get("replan_count", 0)),
        "recovery_replan_count": int(plan.get("recovery_replan_count", 0)),
        "replan_reason": plan.get("last_replan_reason"),
        "completion_quality": plan.get("completion_quality", "nominal"),
        **details,
    }


def fresh_navigation_feedback(now_ns):
    with mpu_lock:
        imu = dict(latest_mpu)
    with odom_lock:
        wheels = dict(latest_wheels) if latest_wheels is not None else None
        wheels_sampled_at_ns = latest_wheels_sampled_at_ns
    imu_sampled_at_ns = int(imu.get("sampled_at_ns", 0))
    imu_age_s = math.inf if imu_sampled_at_ns <= 0 else (now_ns - imu_sampled_at_ns) / 1_000_000_000.0
    wheel_age_s = math.inf if wheels is None else (now_ns - wheels_sampled_at_ns) / 1_000_000_000.0
    if not imu.get("calibrated"):
        raise ClosedLoopControlError("IMU 尚未完成静止校准")
    if imu_age_s > PID_IMU_FEEDBACK_TIMEOUT_S:
        raise ClosedLoopControlError("IMU 反馈超时，自动巡航已停车")
    if wheels is None or wheel_age_s > PID_WHEEL_FEEDBACK_TIMEOUT_S:
        raise ClosedLoopControlError("轮速反馈超时，自动巡航已停车")
    return imu, wheels


def navigation_goal_error_m(plan, definition=None):
    current_definition = definition or navigation_map_definition
    if current_definition is None:
        raise ClosedLoopControlError("导航地图不可用")
    return math.hypot(
        (float(plan["goal"]["x"]) - float(plan["pose"]["x"])) * float(current_definition["width_m"]),
        (float(plan["goal"]["y"]) - float(plan["pose"]["y"])) * float(current_definition["height_m"]),
    )


async def wait_navigation_stationary(task_started_ns):
    """停车后等待短暂稳定；反馈失联或车辆持续运动仍按硬故障处理。"""
    started_ns = time.monotonic_ns()
    quiet_since_ns = None
    while True:
        now_ns = time.monotonic_ns()
        if (now_ns - task_started_ns) / 1_000_000_000.0 > NAVIGATION_MAX_RUNTIME_S:
            raise ClosedLoopControlError("自动巡航超过 3 分钟硬上限")
        imu, wheels = fresh_navigation_feedback(now_ns)
        wheel_stationary = all(
            abs(float(wheels[name])) <= NAVIGATION_STATIONARY_WHEEL_MMPS
            for name in ("M1", "M2", "M3", "M4")
        )
        yaw_stationary = abs(float(imu.get("yaw_rate_dps", 0.0))) <= NAVIGATION_STATIONARY_YAW_DPS
        if wheel_stationary and yaw_stationary:
            quiet_since_ns = quiet_since_ns or now_ns
            if (now_ns - quiet_since_ns) / 1_000_000_000.0 >= NAVIGATION_REPLAN_SETTLE_S:
                return
        else:
            quiet_since_ns = None
        if (now_ns - started_ns) / 1_000_000_000.0 > NAVIGATION_REPLAN_SETTLE_TIMEOUT_S:
            raise ClosedLoopControlError("停车后仍检测到运动，自动巡航已停止")
        await asyncio.sleep(PID_CONTROL_PERIOD_S)


async def replan_navigation_route(plan, task_started_ns, *, reason, recovery):
    """在车辆已停车时，从 Jetson 当前估算位姿重建剩余路径。"""
    control_pwm(0, 0, 0, 0)
    if recovery:
        plan["consecutive_recovery_replans"] += 1
        plan["recovery_replan_count"] += 1
        if plan["consecutive_recovery_replans"] > NAVIGATION_MAX_CONSECUTIVE_RECOVERY_REPLANS:
            raise ClosedLoopControlError("同一区域连续调整超时，自动巡航已停止")
        if plan["recovery_replan_count"] > NAVIGATION_MAX_RECOVERY_REPLANS:
            raise ClosedLoopControlError("自动巡航恢复重规划次数过多，任务已停止")
    else:
        plan["consecutive_recovery_replans"] = 0
    plan["replan_count"] += 1
    plan["last_replan_reason"] = reason
    elapsed_ms = (time.monotonic_ns() - task_started_ns) / 1_000_000.0
    await broadcast_navigation_status(
        "running",
        plan["request_id"],
        **navigation_status_details(
            plan,
            phase="replanning",
            segment_index=int(plan.get("completed_waypoints", 0)),
            remaining_distance_m=plan["distance_m"] - plan["completed_distance_m"],
            elapsed_ms=elapsed_ms,
            reason=(
                "调整超时，已停车并重新规划"
                if recovery
                else "已到达巡航点，正在重新规划"
            ),
        ),
    )
    await wait_navigation_stationary(task_started_ns)
    definition = navigation_map_definition
    if definition is None or int(definition["revision"]) != plan["map_revision"]:
        raise ClosedLoopControlError("导航地图在任务期间发生变化")
    plan["pose"]["heading_deg"] = navigation_pose_heading(plan)
    start = dict(plan["pose"])
    try:
        result = plan_path(definition, start, plan["goal"], maximum_route_m=NAVIGATION_MAX_ROUTE_M)
    except NavigationPlanError as error:
        raise ClosedLoopControlError(f"当前位置重新规划失败：{error}") from error
    segments = split_path_segments(
        result["path"],
        float(definition["width_m"]),
        float(definition["height_m"]),
        NAVIGATION_MAX_SEGMENT_M,
    )
    if within_goal_tolerance(result["distance_m"]):
        segments = []
    if not segments and result["distance_m"] > GOAL_TOLERANCE_M:
        raise ClosedLoopControlError("重新规划结果没有可执行路段")
    plan["path"] = result["path"]
    plan["segments"] = segments
    plan["distance_m"] = plan["completed_distance_m"] + float(result["distance_m"])
    plan["estimated_seconds"] = float(result["estimated_seconds"])
    plan["path_revision"] += 1
    elapsed_ms = (time.monotonic_ns() - task_started_ns) / 1_000_000.0
    await broadcast_navigation_status(
        "running",
        plan["request_id"],
        **navigation_status_details(
            plan,
            phase="replanning",
            segment_index=int(plan.get("completed_waypoints", 0)),
            remaining_distance_m=float(result["distance_m"]),
            elapsed_ms=elapsed_ms,
            reason=(
                "调整超时，已按当前位置生成新路线"
                if recovery
                else "巡航点已更新，继续执行新路线"
            ),
        ),
    )
    return within_goal_tolerance(result["distance_m"])


async def cancel_navigation(reason="cancelled", terminal_state="cancelled"):
    global pending_navigation_plan, navigation_task, navigation_cancel_state, navigation_owner
    task = navigation_task
    navigation_cancel_state = terminal_state
    if task is not None and not task.done() and task is not asyncio.current_task():
        task.cancel(reason)
        try:
            await task
        except asyncio.CancelledError:
            pass
    elif pending_navigation_plan is not None:
        plan = pending_navigation_plan
        pending_navigation_plan = None
        await broadcast_navigation_status(
            terminal_state,
            plan.get("request_id"),
            **navigation_status_details(
                plan,
                phase="stopped",
                segment_index=0,
                remaining_distance_m=plan["distance_m"],
                elapsed_ms=0,
                reason=reason,
            ),
        )
    if navigation_task is task and (task is None or task.done()):
        navigation_task = None
    navigation_owner = None
    control_pwm(0, 0, 0, 0)


async def handle_navigation_map_set(command):
    global navigation_map_definition, pending_navigation_plan
    if navigation_task_running():
        raise ClosedLoopControlError("自动巡航运行中，不能修改地图")
    candidate = validate_map_definition(command.get("map"))
    current_revision = 0 if navigation_map_definition is None else int(navigation_map_definition["revision"])
    base_revision = command.get("base_revision", current_revision)
    if isinstance(base_revision, bool) or not isinstance(base_revision, int) or base_revision != current_revision:
        raise ClosedLoopControlError(f"地图修订冲突，Jetson 当前修订为 {current_revision}")
    if int(candidate["revision"]) != current_revision + 1:
        raise ClosedLoopControlError(f"新地图 revision 必须为 {current_revision + 1}")
    persist_navigation_map(candidate)
    navigation_map_definition = candidate
    pending_navigation_plan = None
    await broadcast_navigation_status(
        "map-ready",
        command_request_id(command),
        ready=True,
        map=candidate,
        map_revision=candidate["revision"],
    )


async def handle_navigation_plan(command):
    global pending_navigation_plan
    if navigation_task_running():
        raise ClosedLoopControlError("已有自动巡航任务正在运行")
    if navigation_map_definition is None:
        raise ClosedLoopControlError("Jetson 尚未保存导航地图")
    map_revision = command.get("map_revision")
    if isinstance(map_revision, bool) or not isinstance(map_revision, int):
        raise ClosedLoopControlError("map_revision 必须是整数")
    if map_revision != navigation_map_definition["revision"]:
        raise ClosedLoopControlError(f"地图修订不匹配，Jetson 当前修订为 {navigation_map_definition['revision']}")
    start = command.get("start")
    goal = command.get("goal")
    if not isinstance(start, dict):
        raise ClosedLoopControlError("start 必须包含当前位置和航向")
    raw_heading_deg = start.get("heading_deg")
    if (
        isinstance(raw_heading_deg, bool)
        or not isinstance(raw_heading_deg, (int, float))
        or not math.isfinite(float(raw_heading_deg))
    ):
        raise ClosedLoopControlError("heading_deg 必须是有限数值")
    # heading_deg is an absolute map heading. Accept every equivalent finite
    # representation and normalize it here so a non-zero initial heading can
    # never become a protocol rejection.
    heading_deg = float(raw_heading_deg) % 360.0
    request_id = command_request_id(command)
    pending_navigation_plan = None
    await broadcast_navigation_status(
        "planning",
        request_id,
        map_revision=map_revision,
    )
    try:
        result = plan_path(navigation_map_definition, start, goal, maximum_route_m=NAVIGATION_MAX_ROUTE_M)
    except NavigationPlanError as error:
        raise ClosedLoopControlError(str(error)) from error
    segments = split_path_segments(
        result["path"],
        float(navigation_map_definition["width_m"]),
        float(navigation_map_definition["height_m"]),
        NAVIGATION_MAX_SEGMENT_M,
    )
    if within_goal_tolerance(result["distance_m"]):
        segments = []
    if not segments and result["distance_m"] > GOAL_TOLERANCE_M:
        raise ClosedLoopControlError("规划结果没有可执行路段")
    task_id = f"navigation-{time.monotonic_ns()}"
    pending_navigation_plan = {
        "request_id": request_id,
        "task_id": task_id,
        "map_revision": map_revision,
        "path": result["path"],
        "segments": segments,
        "distance_m": float(result["distance_m"]),
        "estimated_seconds": float(result["estimated_seconds"]),
        "pose": {
            "x": float(start["x"]),
            "y": float(start["y"]),
            "heading_deg": heading_deg % 360.0,
        },
        "goal": {"x": float(goal["x"]), "y": float(goal["y"])},
        "start_heading_deg": heading_deg % 360.0,
        "imu_start_yaw_deg": 0.0,
        "completed_distance_m": 0.0,
        "completed_waypoints": 0,
        "path_revision": 1,
        "replan_count": 0,
        "recovery_replan_count": 0,
        "consecutive_recovery_replans": 0,
        "last_replan_reason": None,
        "completion_quality": "nominal",
    }
    await broadcast_navigation_status(
        "planned",
        request_id,
        **navigation_status_details(
            pending_navigation_plan,
            phase="ready",
            segment_index=0,
            remaining_distance_m=pending_navigation_plan["distance_m"],
            elapsed_ms=0,
        ),
    )


async def navigation_turn_to(plan, target_heading_deg, segment_index, task_started_ns):
    current_heading_deg = navigation_pose_heading(plan)
    target_delta_deg = shortest_heading_delta(current_heading_deg, target_heading_deg)
    if abs(target_delta_deg) <= NAVIGATION_ANGLE_TOLERANCE_DEG:
        plan["pose"]["heading_deg"] = current_heading_deg
        return
    controller = PIDController(
        kp=PID_TURN_KP,
        ki=0.020,
        kd=0.080,
        output_limit=NAVIGATION_TURN_SPEED_MMPS,
        integral_limit=360.0,
    )
    with mpu_lock:
        start_yaw_deg = float(latest_mpu["yaw_total_deg"])
    started_ns = time.monotonic_ns()
    last_loop_ns = started_ns
    last_status_ns = 0
    last_progress_deg = 0.0
    no_progress_since_ns = started_ns
    settle_samples = 0
    tolerance_latched = False
    while True:
        now_ns = time.monotonic_ns()
        total_elapsed_s = (now_ns - task_started_ns) / 1_000_000_000.0
        phase_elapsed_s = (now_ns - started_ns) / 1_000_000_000.0
        if total_elapsed_s > NAVIGATION_MAX_RUNTIME_S:
            raise ClosedLoopControlError("自动巡航超过 3 分钟硬上限")
        imu, _ = fresh_navigation_feedback(now_ns)
        current_yaw_deg = float(imu["yaw_total_deg"])
        measured_deg = current_yaw_deg - start_yaw_deg
        dt_s = min(PID_IMU_FEEDBACK_TIMEOUT_S, max(0.001, (now_ns - last_loop_ns) / 1_000_000_000.0))
        last_loop_ns = now_ns
        error_deg = target_delta_deg - measured_deg
        yaw_rate_dps = float(imu.get("yaw_rate_dps", 0.0))
        tolerance_latched = navigation_tolerance_latched(
            error_deg,
            tolerance_latched,
            NAVIGATION_ANGLE_TOLERANCE_DEG,
            NAVIGATION_ANGLE_RELEASE_DEG,
        )
        if phase_elapsed_s > NAVIGATION_PID_WAIT_TIMEOUT_S:
            control_pwm(0, 0, 0, 0)
            if abs(error_deg) <= NAVIGATION_ANGLE_RELEASE_DEG and abs(yaw_rate_dps) <= NAVIGATION_STATIONARY_YAW_DPS:
                plan["completion_quality"] = "tolerance"
                return
            raise NavigationReplanRequired("turn-timeout", "转向调整超时")
        output_mmps = bounded_pid_output(
            controller.update(error_deg, dt_s),
            error_deg,
            NAVIGATION_ANGLE_RELEASE_DEG if tolerance_latched else NAVIGATION_ANGLE_TOLERANCE_DEG,
            NAVIGATION_TURN_SPEED_MMPS,
        )
        drive_turn(output_mmps)
        plan["pose"]["heading_deg"] = navigation_pose_heading(plan)
        if abs(measured_deg - last_progress_deg) >= 0.5:
            last_progress_deg = measured_deg
            no_progress_since_ns = now_ns
        elif abs(output_mmps) >= PID_MIN_EFFECTIVE_SPEED_MMPS and (now_ns - no_progress_since_ns) / 1_000_000_000.0 > NAVIGATION_NO_PROGRESS_TIMEOUT_S:
            control_pwm(0, 0, 0, 0)
            if abs(error_deg) <= NAVIGATION_ANGLE_RELEASE_DEG and abs(yaw_rate_dps) <= NAVIGATION_STATIONARY_YAW_DPS:
                plan["completion_quality"] = "tolerance"
                return
            if abs(last_progress_deg) >= 0.5:
                raise NavigationReplanRequired("turn-no-progress", "转向调整无进展")
            raise ClosedLoopControlError("转向无运动反馈，自动巡航已停车")
        if tolerance_latched and abs(yaw_rate_dps) <= NAVIGATION_STATIONARY_YAW_DPS:
            settle_samples += 1
        else:
            settle_samples = 0
        if now_ns - last_status_ns >= int(PID_TELEMETRY_PERIOD_S * 1_000_000_000):
            last_status_ns = now_ns
            await broadcast_navigation_status(
                "running",
                plan["request_id"],
                **navigation_status_details(
                    plan,
                    phase="turning",
                    segment_index=segment_index,
                    remaining_distance_m=plan["distance_m"] - plan["completed_distance_m"],
                    elapsed_ms=total_elapsed_s * 1000,
                    target_heading_deg=target_heading_deg,
                    heading_error_deg=error_deg,
                    output_speed_mmps=output_mmps,
                    tolerance_latched=tolerance_latched,
                ),
            )
        if settle_samples >= NAVIGATION_SETTLE_SAMPLES:
            control_pwm(0, 0, 0, 0)
            return
        await asyncio.sleep(PID_CONTROL_PERIOD_S)


async def navigation_drive_segment(plan, segment, segment_index, task_started_ns):
    definition = navigation_map_definition
    if definition is None or int(definition["revision"]) != plan["map_revision"]:
        raise ClosedLoopControlError("导航地图在任务期间发生变化")
    target_distance_mm = float(segment["distance_m"]) * 1000.0
    controller = PIDController(
        kp=0.80,
        ki=0.035,
        kd=0.045,
        output_limit=NAVIGATION_MAX_STRAIGHT_SPEED_MMPS,
        integral_limit=2000.0,
    )
    started_ns = time.monotonic_ns()
    last_loop_ns = started_ns
    last_status_ns = 0
    no_progress_since_ns = started_ns
    last_progress_mm = 0.0
    measured_mm = 0.0
    settle_samples = 0
    output_mmps = 0.0
    tolerance_latched = False
    while True:
        now_ns = time.monotonic_ns()
        total_elapsed_s = (now_ns - task_started_ns) / 1_000_000_000.0
        phase_elapsed_s = (now_ns - started_ns) / 1_000_000_000.0
        if total_elapsed_s > NAVIGATION_MAX_RUNTIME_S:
            raise ClosedLoopControlError("自动巡航超过 3 分钟硬上限")
        _, wheels = fresh_navigation_feedback(now_ns)
        dt_s = min(PID_WHEEL_FEEDBACK_TIMEOUT_S, max(0.001, (now_ns - last_loop_ns) / 1_000_000_000.0))
        last_loop_ns = now_ns
        measured_speed = longitudinal_speed_mmps(wheels)
        delta_mm = measured_speed * dt_s
        measured_mm += delta_mm
        current_heading_deg = navigation_pose_heading(plan)
        plan["pose"] = integrate_normalized_pose(
            plan["pose"],
            delta_mm / 1000.0,
            current_heading_deg,
            float(definition["width_m"]),
            float(definition["height_m"]),
        )
        if not 0.0 <= plan["pose"]["x"] <= 1.0 or not 0.0 <= plan["pose"]["y"] <= 1.0:
            raise ClosedLoopControlError("估算位置超出地图，自动巡航已停车")
        error_mm = target_distance_mm - measured_mm
        tolerance_latched = navigation_tolerance_latched(
            error_mm,
            tolerance_latched,
            NAVIGATION_DISTANCE_TOLERANCE_MM,
            NAVIGATION_DISTANCE_RELEASE_MM,
        )
        if phase_elapsed_s > NAVIGATION_PID_WAIT_TIMEOUT_S:
            control_pwm(0, 0, 0, 0)
            if abs(error_mm) <= NAVIGATION_DISTANCE_RELEASE_MM and abs(measured_speed) <= NAVIGATION_STATIONARY_WHEEL_MMPS:
                plan["completed_distance_m"] += abs(measured_mm) / 1000.0
                plan["completion_quality"] = "tolerance"
                return
            plan["completed_distance_m"] += abs(measured_mm) / 1000.0
            raise NavigationReplanRequired("drive-timeout", "直线调整超时")
        speed_limit = navigation_speed_limit_mmps(abs(error_mm), phase_elapsed_s)
        requested_output_mmps = bounded_pid_output(
            controller.update(error_mm, dt_s),
            error_mm,
            NAVIGATION_DISTANCE_RELEASE_MM if tolerance_latched else NAVIGATION_DISTANCE_TOLERANCE_MM,
            speed_limit,
        )
        output_mmps = slew_limited_drive_output(
            output_mmps,
            requested_output_mmps,
            dt_s,
            acceleration_mmps2=400.0,
            minimum_effective_mmps=PID_MIN_EFFECTIVE_SPEED_MMPS,
        )
        drive_longitudinal(output_mmps)
        if abs(measured_mm - last_progress_mm) >= 5.0:
            last_progress_mm = measured_mm
            no_progress_since_ns = now_ns
        elif abs(output_mmps) >= PID_MIN_EFFECTIVE_SPEED_MMPS and not tolerance_latched and (now_ns - no_progress_since_ns) / 1_000_000_000.0 > NAVIGATION_NO_PROGRESS_TIMEOUT_S:
            control_pwm(0, 0, 0, 0)
            if abs(error_mm) <= NAVIGATION_DISTANCE_RELEASE_MM and abs(measured_speed) <= NAVIGATION_STATIONARY_WHEEL_MMPS:
                plan["completed_distance_m"] += abs(measured_mm) / 1000.0
                plan["completion_quality"] = "tolerance"
                return
            if abs(last_progress_mm) >= 5.0:
                plan["completed_distance_m"] += abs(measured_mm) / 1000.0
                raise NavigationReplanRequired("drive-no-progress", "直线调整无进展")
            raise ClosedLoopControlError("直线行驶无运动反馈，自动巡航已停车")
        if tolerance_latched and abs(measured_speed) <= NAVIGATION_STATIONARY_WHEEL_MMPS:
            settle_samples += 1
        else:
            settle_samples = 0
        remaining_distance_m = plan["distance_m"] - plan["completed_distance_m"] - abs(measured_mm) / 1000.0
        if now_ns - last_status_ns >= int(PID_TELEMETRY_PERIOD_S * 1_000_000_000):
            last_status_ns = now_ns
            await broadcast_navigation_status(
                "running",
                plan["request_id"],
                **navigation_status_details(
                    plan,
                    phase="driving",
                    segment_index=segment_index,
                    remaining_distance_m=remaining_distance_m,
                    elapsed_ms=total_elapsed_s * 1000,
                    target_distance_mm=target_distance_mm,
                    measured_distance_mm=abs(measured_mm),
                    distance_error_mm=error_mm,
                    output_speed_mmps=output_mmps,
                    tolerance_latched=tolerance_latched,
                ),
            )
        if settle_samples >= NAVIGATION_SETTLE_SAMPLES:
            plan["completed_distance_m"] += abs(measured_mm) / 1000.0
            control_pwm(0, 0, 0, 0)
            return
        await asyncio.sleep(PID_CONTROL_PERIOD_S)


async def navigation_execution(plan):
    global navigation_task, pending_navigation_plan, navigation_cancel_state, navigation_owner
    task_started_ns = time.monotonic_ns()
    try:
        now_ns = time.monotonic_ns()
        imu, _ = fresh_navigation_feedback(now_ns)
        plan["imu_start_yaw_deg"] = float(imu["yaw_total_deg"])
        plan["start_heading_deg"] = float(plan["pose"]["heading_deg"])
        await broadcast_navigation_status(
            "running",
            plan["request_id"],
            **navigation_status_details(
                plan,
                phase="starting",
                segment_index=0,
                remaining_distance_m=plan["distance_m"],
                elapsed_ms=0,
            ),
        )
        while plan["segments"]:
            segment_index = int(plan["completed_waypoints"]) + 1
            segment = plan["segments"][0]
            try:
                await navigation_turn_to(plan, float(segment["heading_deg"]), segment_index, task_started_ns)
                await navigation_drive_segment(plan, segment, segment_index, task_started_ns)
            except NavigationReplanRequired as recovery:
                await replan_navigation_route(
                    plan,
                    task_started_ns,
                    reason=recovery.reason,
                    recovery=True,
                )
                continue
            plan["completed_waypoints"] += 1
            definition = navigation_map_definition
            if definition is None:
                raise ClosedLoopControlError("导航地图不可用")
            if navigation_goal_error_m(plan, definition) <= GOAL_TOLERANCE_M:
                break
            await replan_navigation_route(
                plan,
                task_started_ns,
                reason="waypoint-reached",
                recovery=False,
            )
        definition = navigation_map_definition
        if definition is None:
            raise ClosedLoopControlError("导航地图不可用")
        goal_error_m = navigation_goal_error_m(plan, definition)
        if goal_error_m > GOAL_TOLERANCE_M:
            raise ClosedLoopControlError(f"终点误差 {goal_error_m:.2f}m，超过 0.10m 容差")
        elapsed_ms = (time.monotonic_ns() - task_started_ns) / 1_000_000.0
        await broadcast_navigation_status(
            "completed",
            plan["request_id"],
            **navigation_status_details(
                plan,
                phase="completed",
                segment_index=int(plan["completed_waypoints"]),
                remaining_distance_m=0.0,
                elapsed_ms=elapsed_ms,
                goal_error_m=goal_error_m,
                segment_count=int(plan["completed_waypoints"]),
            ),
        )
    except asyncio.CancelledError as error:
        elapsed_ms = (time.monotonic_ns() - task_started_ns) / 1_000_000.0
        await broadcast_navigation_status(
            navigation_cancel_state,
            plan["request_id"],
            **navigation_status_details(
                plan,
                phase="stopped",
                segment_index=0,
                remaining_distance_m=plan["distance_m"] - plan["completed_distance_m"],
                elapsed_ms=elapsed_ms,
                reason=str(error) or "cancelled",
            ),
        )
        raise
    except Exception as error:
        elapsed_ms = (time.monotonic_ns() - task_started_ns) / 1_000_000.0
        await broadcast_navigation_status(
            "failed",
            plan["request_id"],
            **navigation_status_details(
                plan,
                phase="failed",
                segment_index=0,
                remaining_distance_m=plan["distance_m"] - plan["completed_distance_m"],
                elapsed_ms=elapsed_ms,
                error=str(error),
            ),
        )
    finally:
        control_pwm(0, 0, 0, 0)
        if navigation_task is asyncio.current_task():
            navigation_task = None
            navigation_owner = None
        if pending_navigation_plan is plan:
            pending_navigation_plan = None
        navigation_cancel_state = "cancelled"


async def handle_navigation_start(websocket, command):
    global navigation_task, navigation_owner, manual_motion_owner, manual_motion_request_id
    if navigation_task_running():
        raise ClosedLoopControlError("自动巡航任务已经在运行")
    if pending_navigation_plan is None:
        raise ClosedLoopControlError("没有等待启动的路线")
    if command.get("task_id") != pending_navigation_plan["task_id"]:
        raise ClosedLoopControlError("task_id 与当前待启动路线不匹配")
    await cancel_closed_loop("navigation_start")
    manual_motion_owner = None
    manual_motion_request_id = None
    fresh_navigation_feedback(time.monotonic_ns())
    navigation_owner = websocket
    navigation_task = asyncio.create_task(
        navigation_execution(pending_navigation_plan),
        name=f"navigation-{pending_navigation_plan['task_id']}",
    )


navigation_map_definition = load_navigation_map()

async def cancel_closed_loop(reason="cancelled"):
    global closed_loop_task, closed_loop_owner, closed_loop_request_id
    task = closed_loop_task
    if task is not None and not task.done() and task is not asyncio.current_task():
        task.cancel(reason)
        try:
            await task
        except asyncio.CancelledError:
            pass
    # A task cancelled before its coroutine gets its first timeslice will not
    # enter the coroutine's finally block, so clear ownership here as well.
    if closed_loop_task is task:
        closed_loop_task = None
        closed_loop_owner = None
        closed_loop_request_id = None
    control_pwm(0, 0, 0, 0)

async def distance_pid_loop(owner, request_id, direction, distance_mm, maximum_speed, timeout_s):
    global closed_loop_task, closed_loop_owner, closed_loop_request_id
    signed_target = distance_mm if direction == "forward" else -distance_mm
    controller = PIDController(
        kp=0.80,
        ki=0.035,
        kd=0.045,
        output_limit=maximum_speed,
        integral_limit=2000.0,
    )
    started_ns = time.monotonic_ns()
    last_loop_ns = started_ns
    last_status_ns = 0
    measured_mm = 0.0
    settle_samples = 0
    await broadcast_control_status(
        "started", request_id, "distance",
        direction=direction,
        target_distance_mm=distance_mm,
        max_speed_mmps=maximum_speed,
        timeout_s=timeout_s,
    )
    try:
        while True:
            now_ns = time.monotonic_ns()
            elapsed_s = (now_ns - started_ns) / 1_000_000_000.0
            if elapsed_s > timeout_s:
                raise ClosedLoopControlError("距离控制超时")

            with odom_lock:
                wheels = dict(latest_wheels) if latest_wheels is not None else None
                sampled_at_ns = latest_wheels_sampled_at_ns
            feedback_age_s = math.inf if wheels is None else (now_ns - sampled_at_ns) / 1_000_000_000.0
            if wheels is None or feedback_age_s > PID_WHEEL_FEEDBACK_TIMEOUT_S:
                control_pwm(0, 0, 0, 0)
                if elapsed_s > PID_FEEDBACK_STARTUP_GRACE_S:
                    raise ClosedLoopControlError("轮速反馈超时，距离 PID 已停车")
                last_loop_ns = now_ns
                await asyncio.sleep(PID_CONTROL_PERIOD_S)
                continue

            dt_s = min(PID_WHEEL_FEEDBACK_TIMEOUT_S, max(0.001, (now_ns - last_loop_ns) / 1_000_000_000.0))
            last_loop_ns = now_ns
            measured_speed = longitudinal_speed_mmps(wheels)
            measured_mm += measured_speed * dt_s
            error_mm = signed_target - measured_mm
            raw_output = controller.update(error_mm, dt_s)
            output_mmps = bounded_pid_output(
                raw_output,
                error_mm,
                PID_DISTANCE_TOLERANCE_MM,
                maximum_speed,
            )
            drive_longitudinal(output_mmps)

            if abs(error_mm) <= PID_DISTANCE_TOLERANCE_MM and abs(measured_speed) <= 5.0:
                settle_samples += 1
            else:
                settle_samples = 0

            if now_ns - last_status_ns >= int(PID_TELEMETRY_PERIOD_S * 1_000_000_000):
                last_status_ns = now_ns
                await broadcast_control_status(
                    "running", request_id, "distance",
                    direction=direction,
                    target_distance_mm=distance_mm,
                    measured_distance_mm=abs(measured_mm),
                    error_mm=error_mm,
                    output_speed_mmps=output_mmps,
                    elapsed_ms=int(elapsed_s * 1000),
                )

            if settle_samples >= PID_SETTLE_SAMPLES:
                await broadcast_control_status(
                    "completed", request_id, "distance",
                    direction=direction,
                    target_distance_mm=distance_mm,
                    measured_distance_mm=abs(measured_mm),
                    final_error_mm=error_mm,
                    elapsed_ms=int(elapsed_s * 1000),
                )
                return
            await asyncio.sleep(PID_CONTROL_PERIOD_S)
    except asyncio.CancelledError as error:
        reason = str(error) or "cancelled"
        await broadcast_control_status(
            "cancelled", request_id, "distance",
            direction=direction,
            target_distance_mm=distance_mm,
            measured_distance_mm=abs(measured_mm),
            reason=reason,
        )
        raise
    except Exception as error:
        await broadcast_control_status(
            "failed", request_id, "distance",
            direction=direction,
            target_distance_mm=distance_mm,
            measured_distance_mm=abs(measured_mm),
            error=str(error),
        )
    finally:
        control_pwm(0, 0, 0, 0)
        if closed_loop_task is asyncio.current_task():
            closed_loop_task = None
            closed_loop_owner = None
            closed_loop_request_id = None

async def angle_pid_loop(owner, request_id, direction, angle_deg, maximum_speed, timeout_s):
    global closed_loop_task, closed_loop_owner, closed_loop_request_id
    signed_target = angle_deg if direction == "right" else -angle_deg
    controller = PIDController(
        kp=PID_TURN_KP,
        ki=0.020,
        kd=0.080,
        output_limit=maximum_speed,
        integral_limit=360.0,
    )
    started_ns = time.monotonic_ns()
    last_loop_ns = started_ns
    last_status_ns = 0
    start_yaw_deg = None
    measured_deg = 0.0
    settle_samples = 0
    await broadcast_control_status(
        "started", request_id, "turn",
        direction=direction,
        target_angle_deg=angle_deg,
        max_speed_mmps=maximum_speed,
        timeout_s=timeout_s,
    )
    try:
        while True:
            now_ns = time.monotonic_ns()
            elapsed_s = (now_ns - started_ns) / 1_000_000_000.0
            if elapsed_s > timeout_s:
                raise ClosedLoopControlError("转角控制超时")

            with mpu_lock:
                imu = dict(latest_mpu)
            sampled_at_ns = int(imu.get("sampled_at_ns", 0))
            feedback_age_s = math.inf if sampled_at_ns <= 0 else (now_ns - sampled_at_ns) / 1_000_000_000.0
            if not imu.get("calibrated") or feedback_age_s > PID_IMU_FEEDBACK_TIMEOUT_S:
                control_pwm(0, 0, 0, 0)
                if elapsed_s > PID_FEEDBACK_STARTUP_GRACE_S:
                    reason = "IMU 尚未完成静止校准" if not imu.get("calibrated") else "IMU 反馈超时"
                    raise ClosedLoopControlError(f"{reason}，转角 PID 已停车")
                last_loop_ns = now_ns
                await asyncio.sleep(PID_CONTROL_PERIOD_S)
                continue

            current_yaw_deg = float(imu["yaw_total_deg"])
            if start_yaw_deg is None:
                start_yaw_deg = current_yaw_deg
            measured_deg = current_yaw_deg - start_yaw_deg
            dt_s = min(PID_IMU_FEEDBACK_TIMEOUT_S, max(0.001, (now_ns - last_loop_ns) / 1_000_000_000.0))
            last_loop_ns = now_ns
            error_deg = signed_target - measured_deg
            raw_output = controller.update(error_deg, dt_s)
            output_mmps = bounded_pid_output(
                raw_output,
                error_deg,
                PID_ANGLE_TOLERANCE_DEG,
                maximum_speed,
            )
            drive_turn(output_mmps)

            yaw_rate_dps = float(imu.get("yaw_rate_dps", 0.0))
            if abs(error_deg) <= PID_ANGLE_TOLERANCE_DEG and abs(yaw_rate_dps) <= 1.0:
                settle_samples += 1
            else:
                settle_samples = 0

            if now_ns - last_status_ns >= int(PID_TELEMETRY_PERIOD_S * 1_000_000_000):
                last_status_ns = now_ns
                await broadcast_control_status(
                    "running", request_id, "turn",
                    direction=direction,
                    target_angle_deg=angle_deg,
                    measured_angle_deg=abs(measured_deg),
                    error_deg=error_deg,
                    yaw_rate_dps=yaw_rate_dps,
                    output_speed_mmps=output_mmps,
                    elapsed_ms=int(elapsed_s * 1000),
                )

            if settle_samples >= PID_SETTLE_SAMPLES:
                await broadcast_control_status(
                    "completed", request_id, "turn",
                    direction=direction,
                    target_angle_deg=angle_deg,
                    measured_angle_deg=abs(measured_deg),
                    final_error_deg=error_deg,
                    elapsed_ms=int(elapsed_s * 1000),
                )
                return
            await asyncio.sleep(PID_CONTROL_PERIOD_S)
    except asyncio.CancelledError as error:
        reason = str(error) or "cancelled"
        await broadcast_control_status(
            "cancelled", request_id, "turn",
            direction=direction,
            target_angle_deg=angle_deg,
            measured_angle_deg=abs(measured_deg),
            reason=reason,
        )
        raise
    except Exception as error:
        await broadcast_control_status(
            "failed", request_id, "turn",
            direction=direction,
            target_angle_deg=angle_deg,
            measured_angle_deg=abs(measured_deg),
            error=str(error),
        )
    finally:
        control_pwm(0, 0, 0, 0)
        if closed_loop_task is asyncio.current_task():
            closed_loop_task = None
            closed_loop_owner = None
            closed_loop_request_id = None

async def start_distance_control(websocket, command):
    global closed_loop_task, closed_loop_owner, closed_loop_request_id
    global manual_motion_owner, manual_motion_request_id
    direction = command.get("direction", "forward")
    if direction not in ("forward", "backward"):
        raise ClosedLoopControlError("direction 必须是 forward 或 backward")
    distance_mm = finite_command_number(command, "distance_mm", PID_DISTANCE_MIN_MM, PID_DISTANCE_MAX_MM)
    maximum_speed = finite_command_number(
        command, "max_speed_mmps",
        PID_MIN_EFFECTIVE_SPEED_MMPS, PID_MAX_WHEEL_SPEED_MMPS,
        80.0,
    )
    timeout_s = control_timeout_s(command, distance_mm / maximum_speed * 3.0 + 2.0)
    request_id = command_request_id(command)
    await cancel_navigation("replaced_by_distance_command", "cancelled")
    await cancel_closed_loop("replaced_by_distance_command")
    manual_motion_owner = None
    manual_motion_request_id = None
    closed_loop_owner = websocket
    closed_loop_request_id = request_id
    closed_loop_task = asyncio.create_task(
        distance_pid_loop(websocket, request_id, direction, distance_mm, maximum_speed, timeout_s),
        name=f"distance-pid-{request_id}",
    )

async def start_angle_control(websocket, command):
    global closed_loop_task, closed_loop_owner, closed_loop_request_id
    global manual_motion_owner, manual_motion_request_id
    direction = command.get("direction", "left")
    if direction not in ("left", "right"):
        raise ClosedLoopControlError("direction 必须是 left 或 right")
    angle_deg = finite_command_number(command, "angle_deg", PID_ANGLE_MIN_DEG, PID_ANGLE_MAX_DEG)
    maximum_speed = finite_command_number(
        command, "max_speed_mmps",
        PID_MIN_EFFECTIVE_SPEED_MMPS, PID_MAX_WHEEL_SPEED_MMPS,
        75.0,
    )
    timeout_s = control_timeout_s(command, angle_deg / 25.0 * 3.0 + 2.0)
    request_id = command_request_id(command)
    await cancel_navigation("replaced_by_turn_command", "cancelled")
    await cancel_closed_loop("replaced_by_turn_command")
    manual_motion_owner = None
    manual_motion_request_id = None
    closed_loop_owner = websocket
    closed_loop_request_id = request_id
    closed_loop_task = asyncio.create_task(
        angle_pid_loop(websocket, request_id, direction, angle_deg, maximum_speed, timeout_s),
        name=f"turn-pid-{request_id}",
    )

async def handler(websocket):
    global imu_zero_request_id
    global manual_motion_owner, manual_motion_request_id, navigation_owner
    clients.add(websocket)
    print("Web client connected:", websocket.remote_address)
    try:
        await send_current_navigation_status(websocket)
        async for message in websocket:
            message_size = len(message) if isinstance(message, bytes) else len(message.encode("utf-8"))
            if message_size > NAVIGATION_MAX_COMMAND_BYTES:
                await websocket.close(code=1009, reason="command payload too large")
                break
            cmd = None
            c = None
            try:
                cmd = json.loads(message)
                if not isinstance(cmd, dict):
                    raise ClosedLoopControlError("命令必须是 JSON 对象")
                c = cmd.get("cmd")

                if c == "move":
                    speeds = cmd.get("speeds", [0, 0, 0, 0])
                    if (
                        not isinstance(speeds, list)
                        or len(speeds) != 4
                        or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) for value in speeds)
                        or any(abs(float(value)) > 2000 for value in speeds)
                    ):
                        raise ClosedLoopControlError("speeds 必须是四个 -2000 到 2000 的有限数值")
                    await cancel_navigation("manual_move_override", "cancelled")
                    await cancel_closed_loop("manual_move_override")
                    manual_motion_request_id = command_request_id(cmd)
                    manual_motion_owner = websocket
                    print(f"Moving: {speeds}")
                    control_speed(speeds[0], speeds[1], speeds[2], speeds[3])

                elif c == "stop":
                    print("Stopping")
                    stopped_request_id = (
                        closed_loop_request_id
                        or manual_motion_request_id
                        or command_request_id(cmd)
                    )
                    await cancel_navigation("stop_command", "stopped")
                    await cancel_closed_loop("stop_command")
                    manual_motion_owner = None
                    manual_motion_request_id = None
                    control_pwm(0, 0, 0, 0)
                    await broadcast_control_status("stopped", stopped_request_id, "stop", reason="stop_command")

                elif c == "move_distance":
                    await start_distance_control(websocket, cmd)

                elif c == "turn_angle":
                    await start_angle_control(websocket, cmd)

                elif c == "imu_zero":
                    # 本地归零是人工操作；先安全终止闭环任务，避免归零基准与转向 PID 冲突。
                    request_id = command_request_id(cmd)
                    await cancel_navigation("imu_zero_request", "cancelled")
                    await cancel_closed_loop("imu_zero_request")
                    manual_motion_owner = None
                    manual_motion_request_id = None
                    control_pwm(0, 0, 0, 0)
                    with mpu_lock:
                        imu_zero_request_id = request_id
                    imu_zero_requested.set()
                    print(f"[IMU ZERO] received request_id={request_id}")
                    await broadcast_control_status(
                        "started",
                        request_id,
                        "imu_zero",
                        reason="request_received",
                    )

                elif c in ["forward", "back", "left", "right"]:
                    await cancel_navigation("manual_direction_override", "cancelled")
                    await cancel_closed_loop("manual_direction_override")
                    manual_motion_request_id = command_request_id(cmd)
                    manual_motion_owner = websocket
                    spd = 300
                    if c == "forward":
                        control_speed(spd, -spd, spd, -spd)
                    elif c == "back":
                        control_speed(-spd, spd, -spd, spd)
                    elif c == "left":
                        control_speed(-spd, -spd, spd, spd)
                    elif c == "right":
                        control_speed(spd, spd, -spd, -spd)

                elif c == "navigation_map_get":
                    await send_navigation_payload(websocket, {
                        "type": "navigation",
                        "version": 1,
                        "ts": time.time(),
                        "state": "map-ready",
                        "request_id": command_request_id(cmd),
                        "ready": navigation_map_definition is not None,
                        "map": navigation_map_definition,
                        **({"map_revision": navigation_map_definition["revision"]} if navigation_map_definition else {}),
                    })

                elif c == "navigation_map_set":
                    await handle_navigation_map_set(cmd)

                elif c == "navigation_plan":
                    await handle_navigation_plan(cmd)

                elif c == "navigation_start":
                    await handle_navigation_start(websocket, cmd)

                elif c == "navigation_cancel":
                    task_id = cmd.get("task_id")
                    if task_id is not None and (
                        not isinstance(task_id, str)
                        or pending_navigation_plan is None
                        or task_id != pending_navigation_plan.get("task_id")
                    ):
                        raise ClosedLoopControlError("task_id 与当前导航任务不匹配")
                    await cancel_navigation("navigation_cancel", "cancelled")

                elif c == "navigation_status":
                    await send_current_navigation_status(websocket)

            except Exception as e:
                print("CMD parse error:", e)
                request_id = command_request_id(cmd) if isinstance(cmd, dict) else f"jetson-control-{time.monotonic_ns()}"
                if isinstance(c, str) and c.startswith("navigation_"):
                    failure = {
                        "phase": "failed",
                        "error": str(e),
                        **({"map_revision": navigation_map_definition["revision"]} if navigation_map_definition else {}),
                    }
                    if c == "navigation_plan" and not navigation_task_running():
                        await broadcast_navigation_status("failed", request_id, **failure)
                    else:
                        await send_navigation_payload(websocket, {
                            "type": "navigation",
                            "version": 1,
                            "ts": time.time(),
                            "state": "failed",
                            "request_id": request_id,
                            **failure,
                        })
                else:
                    await broadcast_control_status(
                        "failed",
                        request_id,
                        str(c or "unknown") if isinstance(cmd, dict) else "unknown",
                        error=str(e),
                    )

    except websockets.exceptions.ConnectionClosed:
        print("Web client disconnected")
    finally:
        if closed_loop_owner is websocket:
            await cancel_closed_loop("control_owner_disconnected")
        if navigation_owner is websocket:
            await cancel_navigation("control_owner_disconnected", "cancelled")
        if manual_motion_owner is websocket:
            stopped_request_id = manual_motion_request_id or f"jetson-control-{time.monotonic_ns()}"
            manual_motion_owner = None
            manual_motion_request_id = None
            control_pwm(0, 0, 0, 0)
            await broadcast_control_status(
                "stopped",
                stopped_request_id,
                "move",
                reason="control_owner_disconnected",
            )
        clients.discard(websocket)
        client_network_rtt_ms.pop(websocket, None)

async def measure_client_latency(websocket):
    try:
        started_at_ns = time.monotonic_ns()
        pong_waiter = await websocket.ping()
        await asyncio.wait_for(pong_waiter, timeout=2.0)
        client_network_rtt_ms[websocket] = (time.monotonic_ns() - started_at_ns) / 1_000_000.0
    except Exception:
        client_network_rtt_ms.pop(websocket, None)

async def latency_monitor():
    """通过 WebSocket ping/pong 测量每个客户端 RTT；单程延时只能估算为 RTT/2。"""
    while True:
        if clients:
            await asyncio.gather(
                *(measure_client_latency(client) for client in tuple(clients)),
                return_exceptions=True
            )
        await asyncio.sleep(1.0)

async def odom_broadcast():
    """里程计广播（已加入时间戳 ts）"""
    global latest_wheels, latest_wheels_sampled_at_ns
    while True:
        raw = receive()
        if raw:
            parsed = parse(raw)
            if parsed:
                sampled_at_ns = time.monotonic_ns()
                with odom_lock:
                    latest_wheels = dict(parsed)
                    latest_wheels_sampled_at_ns = sampled_at_ns
                with fire_detection_lock:
                    fire_detected = bool(latest_fire_detected)
                odom_data = dict(parsed)
                odom_data["fire_detected"] = fire_detected
                msg = json.dumps({
                    "type": "odom",
                    "ts": time.time(),
                    "monotonic_ms": sampled_at_ns / 1_000_000.0,
                    "data": odom_data
                })
                if clients:
                    await asyncio.gather(
                        *(client.send(msg) for client in clients),
                        return_exceptions=True
                    )
        await asyncio.sleep(0.05)

async def sensor_broadcast():
    """广播 Jetson 已完成积分的 IMU 快照；漏包不会改变下一包的累计航向。"""
    last_sent_sequence = -1
    while True:
        with mpu_lock:
            data = dict(latest_mpu)
        sequence = int(data.pop("seq"))
        sampled_at_ns = int(data.pop("sampled_at_ns"))
        sampled_at_epoch_s = float(data.pop("sampled_at_epoch_s"))
        if clients and sequence > 0 and sequence != last_sent_sequence:
            async def send_snapshot(client):
                rtt_ms = client_network_rtt_ms.get(client)
                client_data = dict(data)
                client_data["network_rtt_ms"] = rtt_ms
                client_data["network_one_way_ms"] = None if rtt_ms is None else rtt_ms / 2.0
                msg = json.dumps({
                    "type": "imu",
                    "version": 2,
                    "boot_id": IMU_BOOT_ID,
                    "seq": sequence,
                    "ts": sampled_at_epoch_s,
                    "monotonic_ms": sampled_at_ns / 1_000_000.0,
                    "data": client_data
                })
                await client.send(msg)
            await asyncio.gather(
                *(send_snapshot(client) for client in tuple(clients)),
                return_exceptions=True
            )
            last_sent_sequence = sequence
        await asyncio.sleep(0.02)

def encode_video_frame(frame):
    ok, buf = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode('ascii')

async def video_broadcast():
    while True:
        with annotated_lock:
            frame = latest_annotated
        if frame is not None and clients:
            # JPEG 编码移出 asyncio 事件循环，避免阻塞 IMU 与里程计广播。
            loop = asyncio.get_running_loop()
            b64 = await loop.run_in_executor(None, encode_video_frame, frame)
            if b64 is None:
                await asyncio.sleep(0.05)
                continue
            msg = json.dumps({
                "type": "video",
                "data": b64
            })
            await asyncio.gather(
                *(client.send(msg) for client in clients),
                return_exceptions=True
            )
        await asyncio.sleep(0.05)

async def main():
    send("$upload:0,0,1#")
    time.sleep(0.1)
    for cmd, val in [
        ("mtype", 1), ("mphase", 40), ("mline", 11),
        ("wdiameter", 67.00), ("deadzone", 1600)
    ]:
        send(f"${cmd}:{val}#")
        time.sleep(0.1)

    # A Jetson process restart never resumes a prior route or stale motor PWM.
    control_pwm(0, 0, 0, 0)

    cam_thread = Thread(target=camera_grab_loop, daemon=True)
    cam_thread.start()

    infer_thread = Thread(target=inference_loop, daemon=True)
    infer_thread.start()

    mpu_thread = Thread(target=mpu6050_loop, daemon=True)
    mpu_thread.start()

    async with websockets.serve(handler, "0.0.0.0", 8765):
        print("WebSocket server running at ws://0.0.0.0:8765")
        await asyncio.gather(
            odom_broadcast(),
            video_broadcast(),
            sensor_broadcast(),
            latency_monitor()
        )

if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        print("关闭相机...")
        try:
            cam.MV_CC_StopGrabbing()
            cam.MV_CC_CloseDevice()
            cam.MV_CC_DestroyHandle()
        except Exception:
            pass
        try:
            mpu_bus.close()
        except Exception:
            pass
        MvCamera.MV_CC_Finalize()
