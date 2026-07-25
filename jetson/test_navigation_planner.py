import math
import unittest

from navigation_planner import (
    NavigationPlanError,
    build_grid,
    integrate_normalized_pose,
    navigation_speed_limit_mmps,
    plan_path,
    shortest_heading_delta,
    slew_limited_drive_output,
    split_path_segments,
    validate_map_definition,
    within_goal_tolerance,
)


def map_fixture(*, strokes=None, width_m=4.0, height_m=4.0):
    return {
        "version": 1,
        "map_id": "test-room",
        "revision": 1,
        "width_m": width_m,
        "height_m": height_m,
        "resolution_m": 0.05,
        "vehicle": {"length_m": 0.0, "width_m": 0.0, "clearance_m": 0.0},
        "strokes": strokes or [],
    }


class NavigationPlannerTests(unittest.TestCase):
    def test_preserves_wall_cells_without_vehicle_footprint_inflation(self):
        definition = validate_map_definition(map_fixture())
        grid = build_grid(definition)
        self.assertEqual(grid.footprint_radius_m, 0.0)
        self.assertTrue(grid.is_occupied((0, grid.rows // 2)))
        self.assertFalse(grid.is_occupied((3, grid.rows // 2)))
        self.assertFalse(grid.is_occupied((10, grid.rows // 2)))

    def test_plans_and_simplifies_clear_route(self):
        result = plan_path(map_fixture(), {"x": 0.2, "y": 0.2}, {"x": 0.8, "y": 0.8})
        self.assertEqual(result["path"][0], {"x": 0.2, "y": 0.2})
        self.assertEqual(result["path"][-1], {"x": 0.8, "y": 0.8})
        self.assertEqual(len(result["path"]), 2)
        self.assertAlmostEqual(result["distance_m"], math.hypot(2.4, 2.4), places=5)

    def test_rejects_start_inside_drawn_wall(self):
        strokes = [{"id": "wall", "points": [{"x": 0.5, "y": 0.2}, {"x": 0.5, "y": 0.8}]}]
        with self.assertRaisesRegex(NavigationPlanError, "当前位置"):
            plan_path(map_fixture(strokes=strokes), {"x": 0.5, "y": 0.5}, {"x": 0.8, "y": 0.5})

    def test_closed_wall_makes_goal_unreachable(self):
        strokes = [{
            "id": "barrier",
            "points": [{"x": 0.0, "y": 0.5}, {"x": 1.0, "y": 0.5}],
        }]
        with self.assertRaisesRegex(NavigationPlanError, "不可达"):
            plan_path(map_fixture(strokes=strokes), {"x": 0.3, "y": 0.25}, {"x": 0.7, "y": 0.75})

    def test_path_routes_around_static_wall_without_crossing_it(self):
        strokes = [{
            "id": "partial-wall",
            "points": [{"x": 0.5, "y": 0.15}, {"x": 0.5, "y": 0.65}],
        }]
        result = plan_path(map_fixture(strokes=strokes), {"x": 0.25, "y": 0.3}, {"x": 0.75, "y": 0.3})
        self.assertGreater(len(result["path"]), 2)
        self.assertTrue(any(point["y"] < 0.15 or point["y"] > 0.65 for point in result["path"][1:-1]))

    def test_rejects_routes_over_hard_distance_limit(self):
        with self.assertRaisesRegex(NavigationPlanError, "超过"):
            plan_path(
                map_fixture(width_m=20.0, height_m=4.0),
                {"x": 0.2, "y": 0.5},
                {"x": 0.8, "y": 0.5},
            )

    def test_splits_long_edges_at_one_point_five_meters(self):
        segments = split_path_segments(
            [{"x": 0.1, "y": 0.5}, {"x": 0.9, "y": 0.5}],
            4.0,
            4.0,
        )
        self.assertEqual(len(segments), 3)
        self.assertTrue(all(segment["distance_m"] <= 1.5 for segment in segments))
        self.assertTrue(all(abs(segment["heading_deg"] - 90.0) < 1e-9 for segment in segments))

    def test_rejects_oversized_wall_payload(self):
        points = [{"x": index / 4096, "y": 0.5} for index in range(4097)]
        with self.assertRaisesRegex(NavigationPlanError, "4096"):
            validate_map_definition(map_fixture(strokes=[{"id": "too-many", "points": points}]))

    def test_rejects_unsafe_vehicle_envelope(self):
        candidate = map_fixture()
        candidate["vehicle"] = {"length_m": 0.10, "width_m": 0.10, "clearance_m": 0.0}
        with self.assertRaisesRegex(NavigationPlanError, "外廓膨胀已关闭"):
            validate_map_definition(candidate)

    def test_normalizes_the_legacy_vehicle_envelope_without_losing_the_map(self):
        candidate = map_fixture(strokes=[{
            "id": "legacy-wall",
            "points": [{"x": 0.2, "y": 0.2}, {"x": 0.8, "y": 0.2}],
        }])
        candidate["vehicle"] = {"length_m": 0.20, "width_m": 0.15, "clearance_m": 0.05}
        definition = validate_map_definition(candidate)
        self.assertEqual(
            definition["vehicle"],
            {"length_m": 0.0, "width_m": 0.0, "clearance_m": 0.0},
        )
        self.assertEqual(definition["strokes"], candidate["strokes"])

    def test_diagonal_route_does_not_cut_a_drawn_occupied_corner(self):
        strokes = [{
            "id": "corner",
            "points": [{"x": 0.5, "y": 0.0}, {"x": 0.5, "y": 0.51}],
        }]
        result = plan_path(map_fixture(strokes=strokes), {"x": 0.25, "y": 0.25}, {"x": 0.75, "y": 0.75})
        self.assertGreater(len(result["path"]), 2)

    def test_navigation_motion_helpers_follow_map_heading_convention(self):
        right = integrate_normalized_pose(
            {"x": 0.5, "y": 0.5, "heading_deg": 0.0},
            1.0,
            90.0,
            4.0,
            4.0,
        )
        self.assertAlmostEqual(right["x"], 0.75)
        self.assertAlmostEqual(right["y"], 0.5)
        self.assertEqual(shortest_heading_delta(350.0, 10.0), 20.0)
        self.assertEqual(shortest_heading_delta(10.0, 350.0), -20.0)

    def test_navigation_speed_envelope_caps_cruise_and_slows_for_goal(self):
        self.assertEqual(navigation_speed_limit_mmps(1000.0, 0.0), 30.0)
        self.assertEqual(navigation_speed_limit_mmps(1000.0, 1.0), 300.0)
        self.assertEqual(navigation_speed_limit_mmps(200.0, 5.0), 30.0)
        self.assertLess(navigation_speed_limit_mmps(250.0, 5.0), 250.0)

    def test_drive_slew_limit_and_goal_tolerance(self):
        self.assertEqual(slew_limited_drive_output(0.0, 300.0, 0.02), 30.0)
        self.assertEqual(slew_limited_drive_output(30.0, 300.0, 0.05), 50.0)
        self.assertEqual(slew_limited_drive_output(50.0, 0.0, 0.05), 30.0)
        self.assertEqual(slew_limited_drive_output(30.0, 0.0, 0.05), 0.0)
        self.assertTrue(within_goal_tolerance(0.10))
        self.assertFalse(within_goal_tolerance(0.101))


if __name__ == "__main__":
    unittest.main()
