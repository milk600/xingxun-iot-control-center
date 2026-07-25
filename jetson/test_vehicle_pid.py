import ast
import math
from pathlib import Path
import unittest


SOURCE_PATH = Path(__file__).with_name("vehicle_server.py")


def load_pure_symbols():
    tree = ast.parse(SOURCE_PATH.read_text(encoding="utf-8"), filename=str(SOURCE_PATH))
    selected = []
    wanted_assignments = {
        "PID_MIN_EFFECTIVE_SPEED_MMPS",
        "PID_MAX_WHEEL_SPEED_MMPS",
        "PID_TURN_KP",
        "PID_DISTANCE_TOLERANCE_MM",
        "PID_ANGLE_TOLERANCE_DEG",
        "NAVIGATION_PID_WAIT_TIMEOUT_S",
        "NAVIGATION_DISTANCE_TOLERANCE_MM",
        "NAVIGATION_DISTANCE_RELEASE_MM",
        "NAVIGATION_ANGLE_TOLERANCE_DEG",
        "NAVIGATION_ANGLE_RELEASE_DEG",
    }
    wanted_definitions = {
        "PIDController",
        "ClosedLoopControlError",
        "longitudinal_speed_mmps",
        "bounded_pid_output",
        "navigation_tolerance_latched",
        "finite_command_number",
        "is_fire_class_label",
        "yolo_result_has_fire",
    }
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in wanted_definitions:
            selected.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in wanted_assignments
            for target in node.targets
        ):
            selected.append(node)
    namespace = {"math": math}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE_PATH), "exec"), namespace)
    return namespace


SYMBOLS = load_pure_symbols()
PIDController = SYMBOLS["PIDController"]
bounded_pid_output = SYMBOLS["bounded_pid_output"]
navigation_tolerance_latched = SYMBOLS["navigation_tolerance_latched"]
longitudinal_speed_mmps = SYMBOLS["longitudinal_speed_mmps"]
finite_command_number = SYMBOLS["finite_command_number"]
ClosedLoopControlError = SYMBOLS["ClosedLoopControlError"]
PID_MIN_EFFECTIVE_SPEED_MMPS = SYMBOLS["PID_MIN_EFFECTIVE_SPEED_MMPS"]
PID_MAX_WHEEL_SPEED_MMPS = SYMBOLS["PID_MAX_WHEEL_SPEED_MMPS"]
PID_TURN_KP = SYMBOLS["PID_TURN_KP"]
NAVIGATION_PID_WAIT_TIMEOUT_S = SYMBOLS["NAVIGATION_PID_WAIT_TIMEOUT_S"]
NAVIGATION_DISTANCE_TOLERANCE_MM = SYMBOLS["NAVIGATION_DISTANCE_TOLERANCE_MM"]
NAVIGATION_DISTANCE_RELEASE_MM = SYMBOLS["NAVIGATION_DISTANCE_RELEASE_MM"]
NAVIGATION_ANGLE_TOLERANCE_DEG = SYMBOLS["NAVIGATION_ANGLE_TOLERANCE_DEG"]
NAVIGATION_ANGLE_RELEASE_DEG = SYMBOLS["NAVIGATION_ANGLE_RELEASE_DEG"]


class VehiclePidTests(unittest.TestCase):
    def test_manual_and_closed_loop_commands_are_all_present(self):
        source = SOURCE_PATH.read_text(encoding="utf-8")
        for command in (
            "move", "stop", "forward", "back", "left", "right",
            "move_distance", "turn_angle", "imu_zero",
            "navigation_map_get", "navigation_map_set", "navigation_plan",
            "navigation_start", "navigation_cancel", "navigation_status",
        ):
            self.assertIn(f'"{command}"', source)

    def test_navigation_disconnect_and_restart_safety_are_explicit(self):
        source = SOURCE_PATH.read_text(encoding="utf-8")
        handler_finally = source[source.index("async def handler"):source.index("async def measure_client_latency")]
        self.assertIn('cancel_navigation("control_owner_disconnected", "cancelled")', handler_finally)
        self.assertIn("if navigation_owner is websocket:", handler_finally)
        self.assertIn("if manual_motion_owner is websocket:", handler_finally)
        self.assertIn('reason="control_owner_disconnected"', handler_finally)
        self.assertIn("NAVIGATION_MAX_COMMAND_BYTES", source)
        self.assertIn('websocket.close(code=1009, reason="command payload too large")', source)
        main_source = source[source.index("async def main") :]
        self.assertIn("control_pwm(0, 0, 0, 0)", main_source)

    def test_imu_zero_is_applied_locally_and_reported_by_revision(self):
        source = SOURCE_PATH.read_text(encoding="utf-8")
        self.assertIn("imu_zero_requested = Event()", source)
        self.assertIn("imu_zero_requested.set()", source)
        self.assertIn("calibrated and stationary and yaw_rate_dps == 0.0", source)
        self.assertIn("zero_revision += 1", source)
        self.assertIn("valid_dt and not zero_applied", source)
        self.assertIn("[IMU ZERO] received", source)
        self.assertIn("[IMU ZERO] applied", source)
        self.assertIn("[IMU ZERO] rejected", source)

    def test_longitudinal_feedback_respects_motor_polarity(self):
        self.assertEqual(longitudinal_speed_mmps({"M1": 80, "M2": -80, "M3": 80, "M4": -80}), 80)
        self.assertEqual(longitudinal_speed_mmps({"M1": -60, "M2": 60, "M3": -60, "M4": 60}), -60)
        self.assertEqual(longitudinal_speed_mmps({"M1": -50, "M2": -50, "M3": 50, "M4": 50}), 0)

    def test_command_numbers_reject_boolean_nan_and_out_of_range_values(self):
        self.assertEqual(finite_command_number({"distance_mm": 500}, "distance_mm", 50, 1500), 500)
        for value in (True, float("nan"), 49, 1501, "500"):
            with self.assertRaises(ClosedLoopControlError):
                finite_command_number({"distance_mm": value}, "distance_mm", 50, 1500)

    def test_pid_output_clears_the_measured_motor_deadband(self):
        self.assertEqual(PID_MIN_EFFECTIVE_SPEED_MMPS, 30.0)
        self.assertEqual(PID_MAX_WHEEL_SPEED_MMPS, 300.0)
        self.assertEqual(bounded_pid_output(10.0, 20.0, 10.0, 80.0), 30.0)
        self.assertEqual(bounded_pid_output(-10.0, -20.0, 10.0, 80.0), -30.0)
        self.assertEqual(bounded_pid_output(30.0, 10.0, 10.0, 80.0), 0.0)

    def test_all_turn_pid_controllers_use_kp_point_eight(self):
        source = SOURCE_PATH.read_text(encoding="utf-8")
        navigation_turn = source[source.index("async def navigation_turn_to"):source.index("async def navigation_drive_segment")]
        standalone_turn = source[source.index("async def angle_pid_loop"):source.index("async def start_distance_control")]
        self.assertEqual(PID_TURN_KP, 0.80)
        self.assertIn("kp=PID_TURN_KP", navigation_turn)
        self.assertIn("kp=PID_TURN_KP", standalone_turn)
        self.assertNotIn("kp=1.65", source)

    def test_navigation_uses_relaxed_hysteresis_without_changing_standalone_pid(self):
        self.assertEqual(SYMBOLS["PID_DISTANCE_TOLERANCE_MM"], 10.0)
        self.assertEqual(SYMBOLS["PID_ANGLE_TOLERANCE_DEG"], 2.0)
        self.assertEqual((NAVIGATION_DISTANCE_TOLERANCE_MM, NAVIGATION_DISTANCE_RELEASE_MM), (30.0, 60.0))
        self.assertEqual((NAVIGATION_ANGLE_TOLERANCE_DEG, NAVIGATION_ANGLE_RELEASE_DEG), (3.0, 4.0))
        self.assertFalse(navigation_tolerance_latched(31.0, False, 30.0, 60.0))
        self.assertTrue(navigation_tolerance_latched(29.0, False, 30.0, 60.0))
        self.assertTrue(navigation_tolerance_latched(55.0, True, 30.0, 60.0))
        self.assertFalse(navigation_tolerance_latched(61.0, True, 30.0, 60.0))

    def test_navigation_replans_at_waypoints_and_recovers_adjustment_timeouts(self):
        source = SOURCE_PATH.read_text(encoding="utf-8")
        execution = source[source.index("async def navigation_execution"):source.index("async def handle_navigation_start")]
        self.assertIn('reason="waypoint-reached"', execution)
        self.assertIn("except NavigationReplanRequired as recovery", execution)
        self.assertIn('phase="replanning"', source)
        self.assertIn("NAVIGATION_MAX_CONSECUTIVE_RECOVERY_REPLANS = 3", source)
        self.assertIn("NAVIGATION_MAX_RECOVERY_REPLANS = 8", source)
        self.assertEqual(NAVIGATION_PID_WAIT_TIMEOUT_S, 20.0)
        self.assertEqual(source.count("phase_elapsed_s > NAVIGATION_PID_WAIT_TIMEOUT_S"), 2)
        self.assertIn("转向无运动反馈，自动巡航已停车", source)
        self.assertIn("直线行驶无运动反馈，自动巡航已停车", source)

    def test_fire_detection_is_boolean_only_in_odom_payload(self):
        self.assertTrue(SYMBOLS["is_fire_class_label"]("fire"))
        self.assertTrue(SYMBOLS["is_fire_class_label"]("Flame"))
        self.assertTrue(SYMBOLS["is_fire_class_label"]("火焰"))
        self.assertFalse(SYMBOLS["is_fire_class_label"]("smoke"))

        class FakeClasses(list):
            def tolist(self):
                return list(self)

        class FakeBoxes:
            cls = FakeClasses([0])

        class FakeResult:
            boxes = FakeBoxes()

        self.assertTrue(SYMBOLS["yolo_result_has_fire"](FakeResult(), {0: "fire"}))
        self.assertFalse(SYMBOLS["yolo_result_has_fire"](FakeResult(), {0: "smoke"}))
        source = SOURCE_PATH.read_text(encoding="utf-8")
        odom = source[source.index("async def odom_broadcast"):source.index("async def sensor_broadcast")]
        self.assertIn('odom_data["fire_detected"] = fire_detected', odom)
        self.assertNotIn('"boxes"', odom)
        self.assertNotIn('"classes"', odom)

    def test_distance_pid_converges_in_a_first_order_wheel_model(self):
        dt_s = 0.02
        for target_mm in (50.0, 500.0):
            position_mm = 0.0
            speed_mmps = 0.0
            controller = PIDController(0.80, 0.035, 0.045, 80.0, 2000.0)
            for _ in range(int(20 / dt_s)):
                error = target_mm - position_mm
                output = bounded_pid_output(controller.update(error, dt_s), error, 10.0, 80.0)
                speed_mmps += (output - speed_mmps) * min(1.0, dt_s / 0.12)
                position_mm += speed_mmps * dt_s
                if abs(error) <= 10.0 and abs(speed_mmps) <= 5.0:
                    break
            self.assertLessEqual(abs(target_mm - position_mm), 10.0)

    def test_angle_pid_converges_for_left_and_right_turns(self):
        dt_s = 0.02
        for target_deg in (-90.0, -5.0, 5.0, 90.0):
            measured_deg = 0.0
            yaw_rate_dps = 0.0
            controller = PIDController(0.80, 0.020, 0.080, 30.0, 360.0)
            for _ in range(int(20 / dt_s)):
                error = target_deg - measured_deg
                wheel_output = bounded_pid_output(controller.update(error, dt_s), error, 2.0, 30.0)
                requested_yaw_rate = wheel_output * 0.55
                yaw_rate_dps += (requested_yaw_rate - yaw_rate_dps) * min(1.0, dt_s / 0.10)
                measured_deg += yaw_rate_dps * dt_s
                if abs(error) <= 2.0 and abs(yaw_rate_dps) <= 1.0:
                    break
            self.assertLessEqual(abs(target_deg - measured_deg), 2.0)


if __name__ == "__main__":
    unittest.main()
