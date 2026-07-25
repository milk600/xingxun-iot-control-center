"""Static-map path planning for the XingXun Jetson vehicle server.

The planner intentionally depends only on the Python standard library.  The
web client supplies normalized wall strokes; this module validates them,
rasterizes them into a metric occupancy grid, preserves the drawn obstacle
cells without vehicle-footprint inflation, and produces a smoothed A* path.
"""

from __future__ import annotations

from dataclasses import dataclass
import heapq
import math
from typing import Iterable, Sequence


GRID_RESOLUTION_M = 0.05
MAX_STROKES = 256
MAX_TOTAL_POINTS = 4096
MAX_ROUTE_M = 10.0
GOAL_TOLERANCE_M = 0.10
VEHICLE_LENGTH_M = 0.0
VEHICLE_WIDTH_M = 0.0
VEHICLE_CLEARANCE_M = 0.0
LEGACY_VEHICLE_LENGTH_M = 0.20
LEGACY_VEHICLE_WIDTH_M = 0.15
LEGACY_VEHICLE_CLEARANCE_M = 0.05


class NavigationPlanError(ValueError):
    """Raised when a navigation map or route request is not safe to use."""


@dataclass(frozen=True)
class GridMap:
    width_m: float
    height_m: float
    resolution_m: float
    columns: int
    rows: int
    cell_width_m: float
    cell_height_m: float
    occupied: tuple[tuple[bool, ...], ...]
    footprint_radius_m: float

    def normalized_to_cell(self, point: dict[str, float]) -> tuple[int, int]:
        x = min(self.columns - 1, max(0, int(float(point["x"]) * self.columns)))
        y = min(self.rows - 1, max(0, int(float(point["y"]) * self.rows)))
        return x, y

    def cell_to_normalized(self, cell: tuple[int, int]) -> dict[str, float]:
        x, y = cell
        return {
            "x": (x + 0.5) / self.columns,
            "y": (y + 0.5) / self.rows,
        }

    def is_occupied(self, cell: tuple[int, int]) -> bool:
        x, y = cell
        return x < 0 or y < 0 or x >= self.columns or y >= self.rows or self.occupied[y][x]


def _finite_number(value: object, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise NavigationPlanError(f"{name} 必须是有限数值")
    number = float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise NavigationPlanError(f"{name} 必须在 {minimum} 到 {maximum} 之间")
    return number


def _normalized_point(value: object, name: str) -> dict[str, float]:
    if not isinstance(value, dict):
        raise NavigationPlanError(f"{name} 必须是坐标对象")
    return {
        "x": _finite_number(value.get("x"), f"{name}.x", 0.0, 1.0),
        "y": _finite_number(value.get("y"), f"{name}.y", 0.0, 1.0),
    }


def validate_map_definition(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise NavigationPlanError("导航地图必须是 JSON 对象")
    if value.get("version") != 1:
        raise NavigationPlanError("导航地图 version 必须为 1")
    revision = value.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise NavigationPlanError("revision 必须是正整数")
    map_id = value.get("map_id", "room-01")
    if not isinstance(map_id, str) or not 1 <= len(map_id) <= 64:
        raise NavigationPlanError("map_id 无效")

    width_m = _finite_number(value.get("width_m"), "width_m", 2.0, 20.0)
    height_m = _finite_number(value.get("height_m"), "height_m", 2.0, 20.0)
    resolution_m = _finite_number(
        value.get("resolution_m", GRID_RESOLUTION_M),
        "resolution_m",
        GRID_RESOLUTION_M,
        GRID_RESOLUTION_M,
    )

    vehicle = value.get("vehicle")
    if not isinstance(vehicle, dict):
        raise NavigationPlanError("vehicle 必须是对象")
    length_m = _finite_number(vehicle.get("length_m"), "vehicle.length_m", 0.0, 1.5)
    vehicle_width_m = _finite_number(vehicle.get("width_m"), "vehicle.width_m", 0.0, 1.5)
    clearance_m = _finite_number(vehicle.get("clearance_m"), "vehicle.clearance_m", 0.0, 1.0)
    footprint_disabled = math.isclose(length_m, VEHICLE_LENGTH_M, abs_tol=1e-9) \
        and math.isclose(vehicle_width_m, VEHICLE_WIDTH_M, abs_tol=1e-9) \
        and math.isclose(clearance_m, VEHICLE_CLEARANCE_M, abs_tol=1e-9)
    legacy_footprint = math.isclose(length_m, LEGACY_VEHICLE_LENGTH_M, abs_tol=1e-9) \
        and math.isclose(vehicle_width_m, LEGACY_VEHICLE_WIDTH_M, abs_tol=1e-9) \
        and math.isclose(clearance_m, LEGACY_VEHICLE_CLEARANCE_M, abs_tol=1e-9)
    if not footprint_disabled and not legacy_footprint:
        raise NavigationPlanError("车体外廓膨胀已关闭，length_m、width_m 与 clearance_m 必须全部为 0")
    # Keep old persisted maps usable while normalizing every runtime plan to
    # the current no-inflation contract. Drawn wall cells remain occupied.
    length_m = VEHICLE_LENGTH_M
    vehicle_width_m = VEHICLE_WIDTH_M
    clearance_m = VEHICLE_CLEARANCE_M

    strokes = value.get("strokes")
    if not isinstance(strokes, list) or len(strokes) > MAX_STROKES:
        raise NavigationPlanError(f"strokes 必须是不超过 {MAX_STROKES} 段的数组")
    normalized_strokes: list[dict[str, object]] = []
    point_count = 0
    for stroke_index, stroke in enumerate(strokes):
        if not isinstance(stroke, dict):
            raise NavigationPlanError(f"strokes[{stroke_index}] 必须是对象")
        stroke_id = stroke.get("id")
        if not isinstance(stroke_id, str) or not 1 <= len(stroke_id) <= 128:
            raise NavigationPlanError(f"strokes[{stroke_index}].id 无效")
        points = stroke.get("points")
        if not isinstance(points, list) or len(points) < 2:
            raise NavigationPlanError(f"strokes[{stroke_index}].points 至少需要两个点")
        point_count += len(points)
        if point_count > MAX_TOTAL_POINTS:
            raise NavigationPlanError(f"墙线总点数不能超过 {MAX_TOTAL_POINTS}")
        normalized_strokes.append({
            "id": stroke_id,
            "points": [
                _normalized_point(point, f"strokes[{stroke_index}].points[{point_index}]")
                for point_index, point in enumerate(points)
            ],
        })

    return {
        "version": 1,
        "map_id": map_id,
        "revision": revision,
        "width_m": width_m,
        "height_m": height_m,
        "resolution_m": resolution_m,
        "vehicle": {
            "length_m": length_m,
            "width_m": vehicle_width_m,
            "clearance_m": clearance_m,
        },
        "strokes": normalized_strokes,
    }


def _supercover_cells(start: tuple[int, int], end: tuple[int, int]) -> list[tuple[int, int]]:
    """Return every grid cell touched by a segment between two cell centers."""
    x, y = start
    end_x, end_y = end
    dx = end_x - x
    dy = end_y - y
    nx = abs(dx)
    ny = abs(dy)
    sign_x = 0 if dx == 0 else (1 if dx > 0 else -1)
    sign_y = 0 if dy == 0 else (1 if dy > 0 else -1)
    ix = 0
    iy = 0
    cells = [(x, y)]
    while ix < nx or iy < ny:
        decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx
        if decision == 0:
            if sign_x:
                cells.append((x + sign_x, y))
            if sign_y:
                cells.append((x, y + sign_y))
            x += sign_x
            y += sign_y
            ix += 1
            iy += 1
        elif decision < 0:
            x += sign_x
            ix += 1
        else:
            y += sign_y
            iy += 1
        cells.append((x, y))
    return list(dict.fromkeys(cells))


def build_grid(map_definition: object) -> GridMap:
    definition = validate_map_definition(map_definition)
    width_m = float(definition["width_m"])
    height_m = float(definition["height_m"])
    resolution_m = float(definition["resolution_m"])
    columns = max(1, math.ceil(width_m / resolution_m))
    rows = max(1, math.ceil(height_m / resolution_m))
    cell_width_m = width_m / columns
    cell_height_m = height_m / rows
    raw = [[False for _ in range(columns)] for _ in range(rows)]

    # The room edge is always a wall even if the operator draws only interior
    # obstacles.  Inflation below moves this boundary inward by the footprint.
    for x in range(columns):
        raw[0][x] = True
        raw[rows - 1][x] = True
    for y in range(rows):
        raw[y][0] = True
        raw[y][columns - 1] = True

    for stroke in definition["strokes"]:
        points = stroke["points"]
        cells = [
            (
                min(columns - 1, max(0, int(point["x"] * columns))),
                min(rows - 1, max(0, int(point["y"] * rows))),
            )
            for point in points
        ]
        for start, end in zip(cells, cells[1:]):
            for x, y in _supercover_cells(start, end):
                if 0 <= x < columns and 0 <= y < rows:
                    raw[y][x] = True

    vehicle = definition["vehicle"]
    footprint_radius_m = math.hypot(
        float(vehicle["length_m"]) / 2.0,
        float(vehicle["width_m"]) / 2.0,
    ) + float(vehicle["clearance_m"])
    maximum_cell_m = max(cell_width_m, cell_height_m)
    radius_cells = math.ceil(footprint_radius_m / min(cell_width_m, cell_height_m))
    occupied = [[False for _ in range(columns)] for _ in range(rows)]
    offsets: list[tuple[int, int]] = []
    for offset_y in range(-radius_cells, radius_cells + 1):
        for offset_x in range(-radius_cells, radius_cells + 1):
            distance_m = math.hypot(offset_x * cell_width_m, offset_y * cell_height_m)
            if distance_m <= footprint_radius_m + maximum_cell_m * math.sqrt(2) / 2.0:
                offsets.append((offset_x, offset_y))
    for source_y, row in enumerate(raw):
        for source_x, blocked in enumerate(row):
            if not blocked:
                continue
            for offset_x, offset_y in offsets:
                target_x = source_x + offset_x
                target_y = source_y + offset_y
                if 0 <= target_x < columns and 0 <= target_y < rows:
                    occupied[target_y][target_x] = True

    return GridMap(
        width_m=width_m,
        height_m=height_m,
        resolution_m=resolution_m,
        columns=columns,
        rows=rows,
        cell_width_m=cell_width_m,
        cell_height_m=cell_height_m,
        occupied=tuple(tuple(row) for row in occupied),
        footprint_radius_m=footprint_radius_m,
    )


def _neighbors(grid: GridMap, cell: tuple[int, int]) -> Iterable[tuple[tuple[int, int], float]]:
    x, y = cell
    for dx, dy in (
        (-1, 0), (1, 0), (0, -1), (0, 1),
        (-1, -1), (-1, 1), (1, -1), (1, 1),
    ):
        candidate = (x + dx, y + dy)
        if grid.is_occupied(candidate):
            continue
        if dx and dy and (grid.is_occupied((x + dx, y)) or grid.is_occupied((x, y + dy))):
            continue
        cost = math.hypot(dx * grid.cell_width_m, dy * grid.cell_height_m)
        yield candidate, cost


def _line_is_clear(grid: GridMap, start: tuple[int, int], end: tuple[int, int]) -> bool:
    return all(not grid.is_occupied(cell) for cell in _supercover_cells(start, end))


def _simplify_path(grid: GridMap, cells: Sequence[tuple[int, int]]) -> list[tuple[int, int]]:
    if len(cells) <= 2:
        return list(cells)
    simplified = [cells[0]]
    anchor = 0
    while anchor < len(cells) - 1:
        candidate = len(cells) - 1
        while candidate > anchor + 1 and not _line_is_clear(grid, cells[anchor], cells[candidate]):
            candidate -= 1
        simplified.append(cells[candidate])
        anchor = candidate
    return simplified


def _metric_distance(points: Sequence[dict[str, float]], width_m: float, height_m: float) -> float:
    return sum(
        math.hypot(
            (right["x"] - left["x"]) * width_m,
            (right["y"] - left["y"]) * height_m,
        )
        for left, right in zip(points, points[1:])
    )


def plan_path(
    map_definition: object,
    start_value: object,
    goal_value: object,
    *,
    maximum_route_m: float = MAX_ROUTE_M,
) -> dict[str, object]:
    definition = validate_map_definition(map_definition)
    start = _normalized_point(start_value, "start")
    goal = _normalized_point(goal_value, "goal")
    grid = build_grid(definition)
    start_cell = grid.normalized_to_cell(start)
    goal_cell = grid.normalized_to_cell(goal)
    if grid.is_occupied(start_cell):
        raise NavigationPlanError("当前位置位于墙体或安全边界内")
    if grid.is_occupied(goal_cell):
        raise NavigationPlanError("目标点位于墙体或安全边界内")

    frontier: list[tuple[float, float, tuple[int, int]]] = [(0.0, 0.0, start_cell)]
    came_from: dict[tuple[int, int], tuple[int, int] | None] = {start_cell: None}
    best_cost: dict[tuple[int, int], float] = {start_cell: 0.0}
    reached = False
    while frontier:
        _, cost, current = heapq.heappop(frontier)
        if cost > best_cost.get(current, math.inf):
            continue
        if current == goal_cell:
            reached = True
            break
        for neighbor, move_cost in _neighbors(grid, current):
            next_cost = cost + move_cost
            if next_cost >= best_cost.get(neighbor, math.inf):
                continue
            best_cost[neighbor] = next_cost
            came_from[neighbor] = current
            heuristic = math.hypot(
                (goal_cell[0] - neighbor[0]) * grid.cell_width_m,
                (goal_cell[1] - neighbor[1]) * grid.cell_height_m,
            )
            heapq.heappush(frontier, (next_cost + heuristic, next_cost, neighbor))
    if not reached:
        raise NavigationPlanError("目标点不可达，请调整墙线或目标位置")

    cells = [goal_cell]
    while cells[-1] != start_cell:
        parent = came_from.get(cells[-1])
        if parent is None:
            raise NavigationPlanError("路径重建失败")
        cells.append(parent)
    cells.reverse()
    simplified_cells = _simplify_path(grid, cells)
    path = [start]
    path.extend(grid.cell_to_normalized(cell) for cell in simplified_cells[1:-1])
    path.append(goal)
    # Adjacent identical points are unhelpful to the executor and can occur
    # when start/goal happen to sit at the selected grid-cell centers.
    deduplicated: list[dict[str, float]] = []
    for point in path:
        if deduplicated and math.hypot(
            point["x"] - deduplicated[-1]["x"],
            point["y"] - deduplicated[-1]["y"],
        ) < 1e-9:
            continue
        deduplicated.append(point)
    distance_m = _metric_distance(deduplicated, grid.width_m, grid.height_m)
    if distance_m > maximum_route_m:
        raise NavigationPlanError(f"规划路线 {distance_m:.2f}m，超过 {maximum_route_m:.0f}m 上限")
    return {
        "path": deduplicated,
        "distance_m": distance_m,
        "estimated_seconds": distance_m / 0.30 + max(0, len(deduplicated) - 2) * 2.0,
        "goal_tolerance_m": GOAL_TOLERANCE_M,
        "grid": {
            "columns": grid.columns,
            "rows": grid.rows,
            "resolution_m": grid.resolution_m,
            "footprint_radius_m": grid.footprint_radius_m,
        },
    }


def split_path_segments(
    path: Sequence[dict[str, float]],
    width_m: float,
    height_m: float,
    maximum_segment_m: float = 1.5,
) -> list[dict[str, float]]:
    """Split smoothed path edges into executor-safe straight segments."""
    if maximum_segment_m <= 0:
        raise NavigationPlanError("maximum_segment_m 必须大于 0")
    segments: list[dict[str, float]] = []
    for start, end in zip(path, path[1:]):
        dx_m = (float(end["x"]) - float(start["x"])) * width_m
        dy_m = (float(end["y"]) - float(start["y"])) * height_m
        distance_m = math.hypot(dx_m, dy_m)
        if distance_m <= 1e-6:
            continue
        part_count = max(1, math.ceil(distance_m / maximum_segment_m))
        heading_deg = math.degrees(math.atan2(dx_m, -dy_m)) % 360.0
        for part in range(part_count):
            ratio = (part + 1) / part_count
            segments.append({
                "x": float(start["x"]) + (float(end["x"]) - float(start["x"])) * ratio,
                "y": float(start["y"]) + (float(end["y"]) - float(start["y"])) * ratio,
                "heading_deg": heading_deg,
                "distance_m": distance_m / part_count,
            })
    return segments


def shortest_heading_delta(current_deg: float, target_deg: float) -> float:
    """Return the signed clockwise map-heading delta in [-180, 180)."""
    return (float(target_deg) - float(current_deg) + 180.0) % 360.0 - 180.0


def navigation_speed_limit_mmps(
    remaining_mm: float,
    elapsed_s: float,
    *,
    cruise_mmps: float = 300.0,
    approach_mm: float = 200.0,
    minimum_mmps: float = 30.0,
    acceleration_mmps2: float = 400.0,
) -> float:
    """Straight-line speed envelope with deterministic launch and braking ramps."""
    remaining = max(0.0, float(remaining_mm))
    elapsed = max(0.0, float(elapsed_s))
    if remaining <= approach_mm:
        return minimum_mmps
    launch_limit = minimum_mmps + acceleration_mmps2 * elapsed
    # Reach the 30 mm/s approach speed at the start of the final 20 cm,
    # rather than dropping the speed cap abruptly at that boundary.
    braking_limit = math.sqrt(
        minimum_mmps * minimum_mmps
        + 2.0 * acceleration_mmps2 * (remaining - approach_mm)
    )
    return min(cruise_mmps, launch_limit, braking_limit)


def slew_limited_drive_output(
    previous_mmps: float,
    requested_mmps: float,
    dt_s: float,
    *,
    acceleration_mmps2: float = 400.0,
    minimum_effective_mmps: float = 30.0,
) -> float:
    """Rate-limit straight drive output while preserving an effective PWM floor."""
    previous = float(previous_mmps)
    requested = float(requested_mmps)
    maximum_delta = max(0.0, float(dt_s)) * acceleration_mmps2
    if requested == 0.0:
        remaining = max(0.0, abs(previous) - maximum_delta)
        return 0.0 if remaining < minimum_effective_mmps else math.copysign(remaining, previous)
    if previous == 0.0:
        return math.copysign(minimum_effective_mmps, requested)
    if math.copysign(1.0, previous) != math.copysign(1.0, requested):
        return 0.0
    delta = max(-maximum_delta, min(maximum_delta, requested - previous))
    limited = previous + delta
    return math.copysign(max(minimum_effective_mmps, abs(limited)), limited)


def within_goal_tolerance(distance_m: float, tolerance_m: float = GOAL_TOLERANCE_M) -> bool:
    return math.isfinite(float(distance_m)) and 0.0 <= float(distance_m) <= float(tolerance_m)


def integrate_normalized_pose(
    pose: dict[str, float],
    distance_m: float,
    heading_deg: float,
    width_m: float,
    height_m: float,
) -> dict[str, float]:
    """Integrate longitudinal travel in the map convention: 0° is up, clockwise positive."""
    radians = math.radians(float(heading_deg))
    return {
        "x": float(pose["x"]) + math.sin(radians) * float(distance_m) / float(width_m),
        "y": float(pose["y"]) - math.cos(radians) * float(distance_m) / float(height_m),
        "heading_deg": float(heading_deg) % 360.0,
    }
